//! Bounded, panic-free decoder for DuckDuckGo's static HTML result page.
//!
//! `web.search.duckduckgo` is the only keyless route whose provider answers
//! with HTML instead of an MCP JSON-RPC frame, so its fixed adapter needs a
//! hand-rolled scan instead of a JSON pointer walk. Every input here is
//! untrusted network bytes: the scan is linear, every slice is taken at a byte
//! boundary discovered by `str::find`, every field is length-capped, and no
//! step can panic. The normalized rows are then re-emitted as the same bounded
//! `{ title, url, snippet }` JSON shape the other providers expose, so the
//! downstream result parser, count and receipt path never needs to know that
//! HTML was involved.

use std::collections::BTreeSet;

/// Hard cap on rows, matching the aggregate `limit` bound for every route.
pub const MAX_HTML_SEARCH_RESULTS: usize = 10;
/// Byte caps mirror `Horizon.WebSearchV1.ResultItemV1`.
pub const MAX_HTML_TITLE_BYTES: usize = 240;
pub const MAX_HTML_SNIPPET_BYTES: usize = 1_200;
pub const MAX_HTML_URL_BYTES: usize = 2_048;
/// Most bytes of one page the scanner will ever look at.
const MAX_SCAN_BYTES: usize = 2 * 1024 * 1024;
/// Attribute and inner-text windows keep each search bounded.
const ATTR_WINDOW_BYTES: usize = 2_048;
const TITLE_WINDOW_BYTES: usize = 4_096;
const SNIPPET_WINDOW_BYTES: usize = 16_384;
const SNIPPET_LOOKAHEAD_BYTES: usize = 32_768;
/// Ceiling on examined anchors, independent of how many parse successfully.
const MAX_ANCHORS_SCANNED: usize = 64;

const TITLE_MARKER: &str = "class=\"result__a\"";
const SNIPPET_MARKER: &str = "class=\"result__snippet\"";

/// One normalized row. `snippet` is empty when the page carried none.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HtmlSearchResultV1 {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

struct Anchor<'a> {
    href: &'a str,
    inner: &'a str,
    /// Byte offset just past the closing `</a>` of the title anchor.
    end: usize,
}

/// Parse a DuckDuckGo HTML result page into at most `limit` normalized rows.
///
/// Rows whose target is not a bounded `http(s)` URL are dropped rather than
/// rewritten, duplicate targets are collapsed, and an unusable block is skipped
/// without aborting the scan. A page with no recognizable block yields an empty
/// vector, which the caller settles as `EMPTY` and never as a fabricated
/// success.
pub fn parse_duckduckgo_results(body: &[u8], limit: usize) -> Vec<HtmlSearchResultV1> {
    let bounded = limit.clamp(1, MAX_HTML_SEARCH_RESULTS);
    let text = String::from_utf8_lossy(body);
    let text = &text[..scan_limit(&text)];
    let mut results: Vec<HtmlSearchResultV1> = Vec::with_capacity(bounded);
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut cursor = 0usize;
    let mut scanned = 0usize;
    while results.len() < bounded && scanned < MAX_ANCHORS_SCANNED {
        let Some(offset) = text[cursor..].find(TITLE_MARKER) else { break };
        let marker = cursor + offset;
        scanned += 1;
        let Some(anchor) = parse_anchor(text, marker) else {
            // Advance past the marker even when the block is unusable so a
            // malformed page can never stall the scan on one byte offset.
            cursor = marker + TITLE_MARKER.len();
            continue;
        };
        cursor = anchor.end;
        let Some(url) = sanitize_target(anchor.href) else { continue };
        let title = normalize_text(anchor.inner, MAX_HTML_TITLE_BYTES);
        if title.is_empty() || !seen.insert(url.clone()) {
            continue;
        }
        let snippet = snippet_after(text, anchor.end)
            .map(|raw| normalize_text(raw, MAX_HTML_SNIPPET_BYTES))
            .unwrap_or_default();
        results.push(HtmlSearchResultV1 { title, url, snippet });
    }
    results
}

/// Re-emit parsed rows in the fixed `results[]` JSON shape every provider
/// route exposes to Core. Deterministic and byte-bounded by construction.
pub fn normalized_response_body(results: &[HtmlSearchResultV1]) -> Vec<u8> {
    let rows = results
        .iter()
        .take(MAX_HTML_SEARCH_RESULTS)
        .map(|result| {
            let mut row = serde_json::Map::new();
            row.insert("title".to_owned(), serde_json::Value::String(result.title.clone()));
            row.insert("url".to_owned(), serde_json::Value::String(result.url.clone()));
            if !result.snippet.is_empty() {
                row.insert("snippet".to_owned(), serde_json::Value::String(result.snippet.clone()));
            }
            serde_json::Value::Object(row)
        })
        .collect::<Vec<_>>();
    serde_json::to_vec(&serde_json::json!({
        "provider": "duckduckgo",
        "routeId": "web.search.duckduckgo",
        "results": rows,
    }))
    .unwrap_or_else(|_| b"{\"provider\":\"duckduckgo\",\"results\":[]}".to_vec())
}

/// Count rows in an already-normalized body. `None` means the body is not the
/// shape this adapter emits, so the route settles FAILED instead of EMPTY.
pub fn normalized_result_count(body: &[u8]) -> Option<usize> {
    let value: serde_json::Value = serde_json::from_slice(body).ok()?;
    value
        .get("results")?
        .as_array()
        .map(|rows| rows.len().min(MAX_HTML_SEARCH_RESULTS))
}

fn parse_anchor(text: &str, marker: usize) -> Option<Anchor<'_>> {
    let attr_end = window_end(text, marker, ATTR_WINDOW_BYTES);
    let after_marker = marker + TITLE_MARKER.len();
    if after_marker > attr_end {
        return None;
    }
    let tag_close = after_marker + text[after_marker..attr_end].find('>')?;
    let value_attr = after_marker + text[after_marker..tag_close].find("href=")?;
    let value_start = value_attr + "href=".len();
    let quote = text[value_start..tag_close].chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let body = &text[value_start + 1..tag_close];
    let value_end = value_start + 1 + body.find(quote)?;
    let href = &text[value_start + 1..value_end];
    let inner_start = tag_close + 1;
    let inner_end = window_end(text, inner_start, TITLE_WINDOW_BYTES);
    let close = inner_start + text[inner_start..inner_end].find("</a>")?;
    Some(Anchor { href, inner: &text[inner_start..close], end: close + "</a>".len() })
}

fn snippet_after(text: &str, from: usize) -> Option<&str> {
    let lookahead_end = window_end(text, from, SNIPPET_LOOKAHEAD_BYTES);
    let marker = from + text[from..lookahead_end].find(SNIPPET_MARKER)?;
    let tag_end_start = marker + SNIPPET_MARKER.len();
    let tag_end_limit = window_end(text, tag_end_start, ATTR_WINDOW_BYTES);
    let tag_close = tag_end_start + text[tag_end_start..tag_end_limit].find('>')?;
    let inner_start = tag_close + 1;
    let inner_limit = window_end(text, inner_start, SNIPPET_WINDOW_BYTES);
    let close = text[inner_start..inner_limit]
        .find("</a>")
        .or_else(|| text[inner_start..inner_limit].find("</div>"))
        .map(|offset| inner_start + offset)?;
    Some(&text[inner_start..close])
}

/// Largest byte offset `start + len` that is still a `str` boundary.
fn window_end(text: &str, start: usize, len: usize) -> usize {
    let mut end = start.saturating_add(len).min(text.len());
    while end > start && !text.is_char_boundary(end) {
        end -= 1;
    }
    end
}

fn scan_limit(text: &str) -> usize {
    if text.len() <= MAX_SCAN_BYTES {
        return text.len();
    }
    window_end(text, 0, MAX_SCAN_BYTES)
}

/// Strip markup, decode entities, strip again, collapse whitespace, clip.
///
/// The second strip matters: DuckDuckGo escapes the inline formatting it emits
/// as entities (`&lt;em&gt;`), and the page is untrusted input, so
/// entity-encoded markup must not survive into model context. A `<` that does
/// not begin a tag-like token (`a < b`) stays literal text and costs nothing.
fn normalize_text(raw: &str, max_bytes: usize) -> String {
    let decoded = decode_entities(&strip_tags(raw));
    clip(&collapse_whitespace(&strip_tags(&decoded)), max_bytes)
}

fn strip_tags(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    loop {
        let Some(open) = rest.find('<') else {
            out.push_str(rest);
            break;
        };
        out.push_str(&rest[..open]);
        let tail = &rest[open..];
        let markup = tail[1..]
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_alphabetic() || character == '/' || character == '!');
        if !markup {
            out.push('<');
            rest = &tail[1..];
            continue;
        }
        let Some(close) = tail.find('>') else { break };
        rest = &tail[close + 1..];
    }
    out
}

fn decode_entities(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(index) = rest.find('&') {
        out.push_str(&rest[..index]);
        let tail = &rest[index..];
        let semi = tail[..tail.len().min(12)].find(';');
        let decoded = semi.and_then(|semi| {
            decode_entity(&tail[1..semi]).map(|decoded| (decoded, semi + 1))
        });
        match decoded {
            Some((decoded, consumed)) => {
                out.push_str(&decoded);
                rest = &tail[consumed..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn decode_entity(entity: &str) -> Option<String> {
    let named = match entity {
        "amp" => Some('&'),
        "lt" => Some('<'),
        "gt" => Some('>'),
        "quot" => Some('"'),
        "apos" => Some('\''),
        "nbsp" => Some(' '),
        _ => None,
    };
    if let Some(character) = named {
        return Some(character.to_string());
    }
    let number = entity.strip_prefix('#')?;
    let code = match number.strip_prefix('x').or_else(|| number.strip_prefix('X')) {
        Some(hex) => u32::from_str_radix(hex, 16).ok()?,
        None => number.parse::<u32>().ok()?,
    };
    let character = char::from_u32(code)?;
    // Control characters would smuggle terminal escapes into model context.
    if character.is_control() {
        return None;
    }
    Some(character.to_string())
}

fn collapse_whitespace(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut pending = false;
    for character in value.chars() {
        if character.is_control() && !character.is_whitespace() {
            continue;
        }
        if character.is_whitespace() {
            pending = true;
            continue;
        }
        if pending && !out.is_empty() {
            out.push(' ');
        }
        pending = false;
        out.push(character);
    }
    out
}

fn clip(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_owned();
    }
    let mut end = max_bytes;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].trim_end().to_owned()
}

/// Decode the `href` attribute, unwrap the DuckDuckGo redirect, and refuse
/// anything that is not a bounded absolute `http(s)` target.
fn sanitize_target(href: &str) -> Option<String> {
    let decoded = decode_entities(href);
    let trimmed = decoded.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_HTML_URL_BYTES {
        return None;
    }
    match unwrap_redirect(trimmed) {
        Some(target) => http_url(&target),
        None => http_url(trimmed),
    }
}

fn unwrap_redirect(href: &str) -> Option<String> {
    let query = href
        .strip_prefix("//duckduckgo.com/l/?")
        .or_else(|| href.strip_prefix("https://duckduckgo.com/l/?"))
        .or_else(|| href.strip_prefix("http://duckduckgo.com/l/?"))
        .or_else(|| href.strip_prefix("//duckduckgo.com/l?"))?;
    let encoded = query.split('&').find_map(|pair| pair.strip_prefix("uddg="))?;
    percent_decode(encoded)
}

fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0usize;
    while index < bytes.len() {
        match bytes[index] {
            b'%' => {
                let high = hex_digit(*bytes.get(index + 1)?)?;
                let low = hex_digit(*bytes.get(index + 2)?)?;
                out.push(high << 4 | low);
                index += 3;
            }
            b'+' => {
                out.push(b' ');
                index += 1;
            }
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

fn hex_digit(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn http_url(value: &str) -> Option<String> {
    if value.len() > MAX_HTML_URL_BYTES || value.contains('\\') {
        return None;
    }
    if value.bytes().any(|byte| byte.is_ascii_control() || byte.is_ascii_whitespace()) {
        return None;
    }
    let rest = value
        .strip_prefix("https://")
        .or_else(|| value.strip_prefix("http://"))?;
    let authority = rest.split(|character| character == '/' || character == '?' || character == '#')
        .next()
        .unwrap_or("");
    if authority.is_empty() || authority.contains('@') || authority.contains('"') {
        return None;
    }
    Some(value.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Captured from the live endpoint (see the fixture header). The first two
    /// blocks are verbatim provider markup; the last two are synthetic coverage
    /// for direct links/entity decoding and for the non-http drop path.
    const CAPTURED: &str = include_str!("../tests/fixtures/duckduckgo_tokio_select.html");

    #[test]
    fn parses_captured_page_into_normalized_rows() {
        let rows = parse_duckduckgo_results(CAPTURED.as_bytes(), 8);
        assert_eq!(rows.len(), 3, "unexpected row count: {rows:#?}");
        assert_eq!(rows[0].title, "select in tokio - Rust - Docs.rs");
        assert_eq!(rows[0].url, "https://docs.rs/tokio/latest/tokio/macro.select.html");
        assert_eq!(
            rows[0].snippet,
            "The select! macro is a powerful tool for managing multiple asynchronous branches, \
             enabling tasks to run concurrently within the same thread. However, its use can \
             introduce challenges, particularly around cancellation safety, which can lead to \
             subtle and hard-to-debug errors."
        );
        assert_eq!(rows[1].title, "Select | Tokio - An asynchronous Rust runtime");
        assert_eq!(rows[1].url, "https://tokio.rs/tokio/tutorial/select");
        assert!(rows[1].snippet.starts_with("Tokio is a runtime for writing reliable"));
        // Redirect links are unwrapped, never echoed back as duckduckgo.com.
        assert!(rows.iter().all(|row| !row.url.contains("duckduckgo.com")));
    }

    #[test]
    fn decodes_entities_and_strips_inner_tags() {
        let rows = parse_duckduckgo_results(CAPTURED.as_bytes(), 8);
        let direct = rows.iter().find(|row| row.url == "https://example.com/direct-link?x=1&y=2")
            .expect("direct http(s) link must be kept");
        // Entity-encoded markup never reaches model context, and a bare `<` that
        // does not start a tag-like token stays literal.
        assert_eq!(direct.title, "Direct Link & Entity");
        assert_eq!(
            direct.snippet,
            "Numeric & hex 'quoted' entities stay decoded, and inner tags disappear."
        );
    }

    #[test]
    fn drops_results_that_are_not_http_urls() {
        let rows = parse_duckduckgo_results(CAPTURED.as_bytes(), 8);
        assert!(rows.iter().all(|row| row.url.starts_with("http://") || row.url.starts_with("https://")));
        assert!(!rows.iter().any(|row| row.title == "Not an http target"));
    }

    #[test]
    fn honours_the_requested_limit() {
        assert_eq!(parse_duckduckgo_results(CAPTURED.as_bytes(), 1).len(), 1);
        assert_eq!(parse_duckduckgo_results(CAPTURED.as_bytes(), 2).len(), 2);
        assert_eq!(parse_duckduckgo_results(CAPTURED.as_bytes(), 0).len(), 1);
        assert_eq!(parse_duckduckgo_results(CAPTURED.as_bytes(), 999).len(), 3);
    }

    #[test]
    fn zero_results_page_is_empty_not_fabricated() {
        let page = "<html><body><div class=\"no-results\">No results.</div></body></html>";
        assert!(parse_duckduckgo_results(page.as_bytes(), 8).is_empty());
        assert!(parse_duckduckgo_results(b"", 8).is_empty());
        let body = normalized_response_body(&[]);
        assert_eq!(normalized_result_count(&body), Some(0));
        assert!(String::from_utf8_lossy(&body).contains("\"results\":[]"));
    }

    #[test]
    fn malformed_input_never_panics() {
        let inputs: [&[u8]; 12] = [
            b"",
            b"<",
            b"&",
            b"&#;",
            b"&#x;",
            b"<a class=\"result__a\"",
            b"<a class=\"result__a\" href=",
            b"<a class=\"result__a\" href=\"//duckduckgo.com/l/?uddg=%ZZ\">t</a>",
            b"<a class=\"result__a\" href=\"//duckduckgo.com/l/?uddg=%E0%A4%A\">t</a>",
            b"<a class=\"result__a\" href=\"https://ok.test/\">\xff\xfe</a>",
            b"class=\"result__a\" href=\"\"",
            &[0xffu8; 64],
        ];
        for input in inputs {
            let rows = parse_duckduckgo_results(input, 8);
            assert!(rows.len() <= 10);
            for row in rows {
                assert!(row.url.starts_with("http"));
                assert!(row.title.len() <= MAX_HTML_TITLE_BYTES);
                assert!(row.snippet.len() <= MAX_HTML_SNIPPET_BYTES);
            }
        }
    }

    #[test]
    fn unwraps_percent_encoded_redirect_targets() {
        let page = "<a class=\"result__a\" href=\"//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%2Bb%3Fq%3D1&amp;rut=x\">T</a>";
        let rows = parse_duckduckgo_results(page.as_bytes(), 4);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].url, "https://example.com/a+b?q=1");
        assert_eq!(rows[0].snippet, "");

        let absolute = "<a class=\"result__a\" href=\"https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fz\">T</a>";
        assert_eq!(parse_duckduckgo_results(absolute.as_bytes(), 2)[0].url, "https://example.org/z");
    }

    #[test]
    fn deduplicates_repeated_targets() {
        let page = concat!(
            "<a class=\"result__a\" href=\"https://dup.test/x\">First</a>",
            "<a class=\"result__a\" href=\"https://dup.test/x\">Second</a>",
        );
        let rows = parse_duckduckgo_results(page.as_bytes(), 8);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].title, "First");
    }

    #[test]
    fn normalized_body_round_trips_through_the_count_contract() {
        let rows = parse_duckduckgo_results(CAPTURED.as_bytes(), 8);
        let body = normalized_response_body(&rows);
        assert_eq!(normalized_result_count(&body), Some(rows.len()));
        let value: serde_json::Value = serde_json::from_slice(&body).expect("normalized body is JSON");
        assert_eq!(value.get("provider").and_then(|v| v.as_str()), Some("duckduckgo"));
        assert_eq!(value.get("routeId").and_then(|v| v.as_str()), Some("web.search.duckduckgo"));
        let first = &value["results"][0];
        assert_eq!(first["title"].as_str(), Some(rows[0].title.as_str()));
        assert_eq!(first["url"].as_str(), Some(rows[0].url.as_str()));
        assert_eq!(first["snippet"].as_str(), Some(rows[0].snippet.as_str()));
        // A row without a snippet omits the field instead of emitting "".
        let mut trimmed = rows.clone();
        trimmed[1].snippet.clear();
        let value: serde_json::Value =
            serde_json::from_slice(&normalized_response_body(&trimmed)).expect("json");
        assert!(value["results"][1].get("snippet").is_none());
        assert!(normalized_result_count(b"not json").is_none());
        assert!(normalized_result_count(b"{\"rows\":[]}").is_none());
    }

    #[test]
    fn preserves_a_literal_less_than_that_is_not_markup() {
        let page = "<a class=\"result__a\" href=\"https://ok.test/\">a &lt; b &amp;&amp; c &gt; d</a>";
        assert_eq!(parse_duckduckgo_results(page.as_bytes(), 2)[0].title, "a < b && c > d");
    }

    #[test]
    fn clips_overlong_fields_to_the_public_bounds() {
        let long_title = "t".repeat(4_000);
        let long_snippet = "s".repeat(8_000);
        let page = format!(
            "<a class=\"result__a\" href=\"https://ok.test/\">{long_title}</a>\
             <a class=\"result__snippet\" href=\"https://ok.test/\">{long_snippet}</a>"
        );
        let rows = parse_duckduckgo_results(page.as_bytes(), 4);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].title.len(), MAX_HTML_TITLE_BYTES);
        assert_eq!(rows[0].snippet.len(), MAX_HTML_SNIPPET_BYTES);
    }

    #[test]
    fn live_duckduckgo_query_prints_parsed_results() {
        // Network test intentionally gated: `HORIZON_LIVE_WEB_SEARCH=1 cargo test
        // -p horizoncode-kernel live_duckduckgo_query -- --nocapture`.
        if std::env::var("HORIZON_LIVE_WEB_SEARCH").as_deref() != Ok("1") {
            return;
        }
        let query = std::env::var("HORIZON_LIVE_WEB_SEARCH_QUERY")
            .unwrap_or_else(|_| "RFC 9457 problem details".to_owned());
        let mut target = reqwest::Url::parse("https://html.duckduckgo.com/html/").expect("fixed url");
        target.query_pairs_mut().append_pair("q", &query);
        let limit = 5usize;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_io()
            .enable_time()
            .build()
            .expect("runtime");
        let (status, body) = runtime
            .block_on(async {
                let client = reqwest::Client::builder()
                    .https_only(true)
                    .no_proxy()
                    .redirect(reqwest::redirect::Policy::none())
                    .connect_timeout(std::time::Duration::from_secs(10))
                    .timeout(std::time::Duration::from_secs(25))
                    .build()
                    .map_err(|error| error.to_string())?;
                let response = client
                    .get(target.to_string())
                    .header(
                        reqwest::header::USER_AGENT,
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                         (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
                    )
                    .header(
                        reqwest::header::ACCEPT,
                        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    )
                    .header(reqwest::header::ACCEPT_LANGUAGE, "en-US,en;q=0.9")
                    .send()
                    .await
                    .map_err(|error| error.to_string())?;
                let status = response.status().as_u16();
                let body = response.bytes().await.map_err(|error| error.to_string())?;
                Ok::<(u16, Vec<u8>), String>((status, body.to_vec()))
            })
            .expect("live DuckDuckGo request");
        let rows = parse_duckduckgo_results(&body, limit);
        println!("LIVE http={status} query={query:?} bytes={} rows={}", body.len(), rows.len());
        for (index, row) in rows.iter().enumerate() {
            println!("LIVE[{index}] title={:?} url={:?} snippet={:?}", row.title, row.url, row.snippet);
        }
        assert_eq!(status, 200, "live query must answer 200");
        assert!(!rows.is_empty(), "live query must parse at least one result");
    }
}
