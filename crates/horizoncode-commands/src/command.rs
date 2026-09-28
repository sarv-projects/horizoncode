//! The command registry: descriptors, strict parsing, help, and search.
//!
//! Only commands whose owning service exists are registered. Each descriptor
//! names its owner, its surface, and its effect class, so the registry can
//! answer *is this available here, and who owns it* without the caller
//! hard-coding a match arm.

/// Which surface offers a command.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Surface {
    /// The non-interactive `-p` surface.
    Headless,
    /// The ACP server's client surface.
    Acp,
    /// The interactive terminal UI.
    Tui,
}

impl Surface {
    /// Returns the stable wire name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Headless => "headless",
            Self::Acp => "acp",
            Self::Tui => "tui",
        }
    }
}

/// How much authority a command carries.
///
/// The class is declarative: this crate never performs the effect. It exists so
/// a surface can decide what needs an approval path before it dispatches.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EffectClass {
    /// Reads local state; acquires no write lock.
    ReadOnly,
    /// Persists a preference.
    Preference,
    /// A priority control-lane action (pause, cancel, stop).
    Control,
    /// An effect that needs the normal guard/confirmation path.
    Guarded,
}

impl EffectClass {
    /// Returns the stable wire name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ReadOnly => "read_only",
            Self::Preference => "preference",
            Self::Control => "control",
            Self::Guarded => "guarded",
        }
    }
}

/// Whether the owning service is present in this build or session.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Availability {
    /// The owner is present.
    Available,
    /// The owner is absent; the reason is shown instead of a no-op.
    Unavailable {
        /// Why the command cannot run.
        reason: &'static str,
    },
}

/// One declared command.
#[derive(Clone, Copy, Debug)]
pub struct CommandDescriptor {
    /// The stable, namespaced id, without the leading slash.
    pub id: &'static str,
    /// Alternative names; they cannot shadow another command.
    pub aliases: &'static [&'static str],
    /// One line shown in the command list.
    pub summary: &'static str,
    /// The argument grammar, as shown in help and used by the parse rule.
    pub argument_schema: &'static str,
    /// The service that owns the behavior.
    pub owner: &'static str,
    /// Whether the owner is present.
    pub availability: Availability,
    /// The surfaces that may offer it.
    pub allowed_surfaces: &'static [Surface],
    /// The authority class.
    pub effect_class: EffectClass,
}

/// The registered commands.
///
/// A command whose owner does not exist yet is deliberately absent rather than
/// registered as a no-op: the parser then returns an unknown-command error with
/// suggestions, which the architecture requires, instead of pretending.
static REGISTRY: &[CommandDescriptor] = &[
    CommandDescriptor {
        id: "commands",
        aliases: &[],
        summary: "Search the available commands with their owner and availability.",
        argument_schema: "[filter]",
        owner: "CMP-commands",
        availability: Availability::Available,
        allowed_surfaces: &[Surface::Headless],
        effect_class: EffectClass::ReadOnly,
    },
    CommandDescriptor {
        id: "help",
        aliases: &[],
        summary: "Show help for a command topic.",
        argument_schema: "[topic]",
        owner: "CMP-commands",
        availability: Availability::Available,
        allowed_surfaces: &[Surface::Headless],
        effect_class: EffectClass::ReadOnly,
    },
    CommandDescriptor {
        id: "insights",
        aliases: &[],
        summary: "Inspect local aggregate metrics and their provenance.",
        argument_schema: "[--days N]",
        owner: "CMP-analytics",
        availability: Availability::Available,
        allowed_surfaces: &[Surface::Headless],
        effect_class: EffectClass::ReadOnly,
    },
    CommandDescriptor {
        id: "usage",
        aliases: &[],
        summary: "Show observed usage and cost.",
        argument_schema: "",
        owner: "CMP-analytics",
        availability: Availability::Available,
        allowed_surfaces: &[Surface::Headless],
        effect_class: EffectClass::ReadOnly,
    },
];

/// The window `/insights` uses when no `--days` is given.
pub const DEFAULT_INSIGHTS_DAYS: u32 = 7;

/// Returns the registered commands.
#[must_use]
pub fn registry() -> &'static [CommandDescriptor] {
    REGISTRY
}

/// A parsed, validated invocation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Invocation {
    /// `/commands [filter]`
    Commands {
        /// The optional case-insensitive filter.
        filter: Option<String>,
    },
    /// `/help [topic]`
    Help {
        /// The optional topic; without one, the full list is shown.
        topic: Option<String>,
    },
    /// `/insights [--days N]`
    Insights {
        /// The window in days.
        days: u32,
    },
    /// `/usage`
    Usage,
}

impl Invocation {
    /// The descriptor id this invocation resolved to.
    #[must_use]
    pub fn id(&self) -> &'static str {
        match self {
            Self::Commands { .. } => "commands",
            Self::Help { .. } => "help",
            Self::Insights { .. } => "insights",
            Self::Usage { .. } => "usage",
        }
    }
}

/// Why a slash invocation could not be accepted.
#[derive(Debug, thiserror::Error)]
pub enum CommandError {
    /// The input does not start with a slash.
    #[error("not a slash command")]
    NotACommand,
    /// No command has this name.
    #[error("unknown command `/{name}`{}", suggestions_text(.suggestions))]
    Unknown {
        /// The name as typed.
        name: String,
        /// Nearest registered names, when any.
        suggestions: Vec<String>,
    },
    /// The name is known but the arguments are not.
    #[error("`/{id}` {detail}; expected `/{id} {schema}`")]
    Malformed {
        /// The command id.
        id: &'static str,
        /// What was wrong with the arguments.
        detail: String,
        /// The argument grammar.
        schema: &'static str,
    },
    /// The command's owner is absent.
    #[error("`/{id}` is unavailable: {reason}")]
    Unavailable {
        /// The command id.
        id: &'static str,
        /// Why it cannot run.
        reason: &'static str,
    },
    /// The command is not offered on the calling surface.
    #[error("`/{id}` is not offered on the {} surface", surface.as_str())]
    UnsupportedSurface {
        /// The command id.
        id: &'static str,
        /// The calling surface.
        surface: Surface,
    },
}

fn suggestions_text(suggestions: &[String]) -> String {
    if suggestions.is_empty() {
        String::new()
    } else {
        format!("; nearest: {}", suggestions.join(", "))
    }
}

/// Parses a slash invocation for the headless surface.
///
/// # Errors
/// Returns [`CommandError`] for a non-command, an unknown name, malformed
/// arguments, an unavailable owner, or a command this surface may not offer.
/// The caller must not fall through to a model prompt on any of these.
pub fn parse(input: &str) -> Result<Invocation, CommandError> {
    parse_on(input, Surface::Headless)
}

/// [`parse`] for a named surface.
///
/// # Errors
/// As [`parse`], plus [`CommandError::UnsupportedSurface`].
pub fn parse_on(input: &str, surface: Surface) -> Result<Invocation, CommandError> {
    let trimmed = input.trim();
    let Some(rest) = trimmed.strip_prefix('/') else {
        return Err(CommandError::NotACommand);
    };
    let mut parts = rest.split_whitespace();
    let name = parts.next().unwrap_or_default();
    let arguments: Vec<&str> = parts.collect();
    let Some(descriptor) = find(name) else {
        return Err(CommandError::Unknown {
            name: name.to_owned(),
            suggestions: nearest(name),
        });
    };
    if !descriptor.allowed_surfaces.contains(&surface) {
        return Err(CommandError::UnsupportedSurface {
            id: descriptor.id,
            surface,
        });
    }
    if let Availability::Unavailable { reason } = descriptor.availability {
        return Err(CommandError::Unavailable {
            id: descriptor.id,
            reason,
        });
    }
    let malformed = |detail: &str| CommandError::Malformed {
        id: descriptor.id,
        detail: detail.to_owned(),
        schema: descriptor.argument_schema,
    };
    match descriptor.id {
        "commands" => match arguments.as_slice() {
            [] => Ok(Invocation::Commands { filter: None }),
            [filter] => Ok(Invocation::Commands {
                filter: Some((*filter).to_owned()),
            }),
            _ => Err(malformed("takes at most one filter word")),
        },
        "help" => match arguments.as_slice() {
            [] => Ok(Invocation::Help { topic: None }),
            [topic] => Ok(Invocation::Help {
                topic: Some((*topic).to_owned()),
            }),
            _ => Err(malformed("takes at most one topic")),
        },
        "insights" => match arguments.as_slice() {
            [] => Ok(Invocation::Insights {
                days: DEFAULT_INSIGHTS_DAYS,
            }),
            ["--days", value] => Ok(Invocation::Insights {
                days: parse_days(value).map_err(|detail| malformed(&detail))?,
            }),
            [value] if value.starts_with("--days=") => Ok(Invocation::Insights {
                days: parse_days(value.trim_start_matches("--days="))
                    .map_err(|detail| malformed(&detail))?,
            }),
            _ => Err(malformed("takes `--days N` and nothing else")),
        },
        "usage" => match arguments.as_slice() {
            [] => Ok(Invocation::Usage),
            _ => Err(malformed("takes no arguments")),
        },
        _ => Err(CommandError::Unknown {
            name: name.to_owned(),
            suggestions: nearest(name),
        }),
    }
}

fn parse_days(value: &str) -> Result<u32, String> {
    value
        .parse::<u32>()
        .map_err(|_| format!("`{value}` is not a number of days"))
}

fn find(name: &str) -> Option<&'static CommandDescriptor> {
    REGISTRY
        .iter()
        .find(|descriptor| descriptor.id == name || descriptor.aliases.contains(&name))
}

/// Commands whose id or summary contains `filter`, case-insensitively.
/// An empty filter returns every command.
#[must_use]
pub fn search(filter: &str) -> Vec<&'static CommandDescriptor> {
    let needle = filter.to_lowercase();
    REGISTRY
        .iter()
        .filter(|descriptor| {
            needle.is_empty()
                || descriptor.id.to_lowercase().contains(&needle)
                || descriptor.summary.to_lowercase().contains(&needle)
                || descriptor.owner.to_lowercase().contains(&needle)
        })
        .collect()
}

/// Command names and aliases that begin with `prefix`, sorted, for completion.
#[must_use]
pub fn complete(prefix: &str) -> Vec<&'static str> {
    let mut out: Vec<&'static str> = REGISTRY
        .iter()
        .flat_map(|descriptor| {
            std::iter::once(descriptor.id).chain(descriptor.aliases.iter().copied())
        })
        .filter(|name| name.starts_with(prefix))
        .collect();
    out.sort_unstable();
    out
}

/// Renders the command list or one command's detail.
///
/// # Errors
/// Returns [`CommandError::Unknown`] with suggestions when `topic` names no
/// registered command.
pub fn render_help(topic: Option<&str>) -> Result<String, CommandError> {
    match topic {
        None => Ok(list(&search(""))),
        Some(topic) => {
            let Some(descriptor) = find(topic) else {
                return Err(CommandError::Unknown {
                    name: topic.to_owned(),
                    suggestions: nearest(topic),
                });
            };
            Ok(detail(descriptor))
        }
    }
}

/// Renders the filtered command list.
#[must_use]
pub fn render_commands(filter: Option<&str>) -> String {
    list(&search(filter.unwrap_or_default()))
}

fn list(commands: &[&'static CommandDescriptor]) -> String {
    let mut out = String::from("Commands (owner · availability · effect):\n");
    for descriptor in commands {
        out.push_str(&format!(
            "  /{:<10} {:<44} {} · {} · {}\n",
            format!("{} {}", descriptor.id, descriptor.argument_schema).trim(),
            descriptor.summary,
            descriptor.owner,
            match descriptor.availability {
                Availability::Available => "available".to_owned(),
                Availability::Unavailable { reason } => format!("unavailable: {reason}"),
            },
            descriptor.effect_class.as_str(),
        ));
    }
    out.push_str("Run `/help <topic>` for one command's detail.\n");
    out
}

fn detail(descriptor: &CommandDescriptor) -> String {
    let mut out = format!("`/{id}`\n", id = descriptor.id);
    out.push_str(&format!("  summary:   {}\n", descriptor.summary));
    let usage = format!("/{} {}", descriptor.id, descriptor.argument_schema);
    out.push_str(&format!("  usage:     {}\n", usage.trim_end()));
    if !descriptor.aliases.is_empty() {
        out.push_str(&format!("  aliases:   {}\n", descriptor.aliases.join(", ")));
    }
    out.push_str(&format!("  owner:     {}\n", descriptor.owner));
    out.push_str(&format!(
        "  effect:    {}\n",
        descriptor.effect_class.as_str()
    ));
    out.push_str(&format!(
        "  surfaces:  {}\n",
        descriptor
            .allowed_surfaces
            .iter()
            .map(|surface| surface.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    ));
    match descriptor.availability {
        Availability::Available => out.push_str("  state:     available\n"),
        Availability::Unavailable { reason } => {
            out.push_str(&format!("  state:     unavailable: {reason}\n"));
        }
    }
    out
}

/// Up to three registered names near `name`, for the suggestion line.
fn nearest(name: &str) -> Vec<String> {
    let mut scored: Vec<(usize, &'static str)> = REGISTRY
        .iter()
        .map(|descriptor| (distance(name, descriptor.id), descriptor.id))
        .filter(|(distance, _)| *distance <= 3)
        .collect();
    scored.sort_unstable();
    scored
        .into_iter()
        .take(3)
        .map(|(_, id)| format!("/{id}"))
        .collect()
}

/// A small edit distance, bounded by the short command names.
fn distance(left: &str, right: &str) -> usize {
    let left: Vec<char> = left.chars().collect();
    let right: Vec<char> = right.chars().collect();
    let mut previous: Vec<usize> = (0..=right.len()).collect();
    let mut current = vec![0usize; right.len() + 1];
    for (i, a) in left.iter().enumerate() {
        current[0] = i + 1;
        for (j, b) in right.iter().enumerate() {
            let substitution = previous[j] + usize::from(a != b);
            current[j + 1] = substitution.min(previous[j + 1] + 1).min(current[j] + 1);
        }
        std::mem::swap(&mut previous, &mut current);
    }
    previous[right.len()]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_registered_commands_all_have_owners_and_parse_rules() {
        for descriptor in registry() {
            assert!(!descriptor.id.is_empty());
            assert!(!descriptor.owner.is_empty());
            assert!(!descriptor.summary.is_empty());
            assert!(!descriptor.allowed_surfaces.is_empty());
            assert!(
                parse_on(&format!("/{}", descriptor.id), Surface::Headless).is_ok(),
                "/{} must parse",
                descriptor.id
            );
        }
    }

    #[test]
    fn command_ids_and_aliases_are_unique() {
        let mut names = Vec::new();
        for descriptor in registry() {
            names.push(descriptor.id);
            names.extend(descriptor.aliases.iter().copied());
        }
        let mut sorted = names.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), names.len(), "a name is declared twice");
    }

    #[test]
    fn known_commands_parse_their_documented_arguments() {
        assert_eq!(parse("/usage").unwrap(), Invocation::Usage);
        assert_eq!(
            parse("/insights").unwrap(),
            Invocation::Insights {
                days: DEFAULT_INSIGHTS_DAYS
            }
        );
        assert_eq!(
            parse("/insights --days 3").unwrap(),
            Invocation::Insights { days: 3 }
        );
        assert_eq!(
            parse("/insights --days=30").unwrap(),
            Invocation::Insights { days: 30 }
        );
        assert_eq!(parse("/help").unwrap(), Invocation::Help { topic: None });
        assert_eq!(
            parse("/help usage").unwrap(),
            Invocation::Help {
                topic: Some("usage".to_owned())
            }
        );
        assert_eq!(
            parse("/commands ledger").unwrap(),
            Invocation::Commands {
                filter: Some("ledger".to_owned())
            }
        );
    }

    #[test]
    fn unknown_commands_are_refused_with_suggestions_and_never_become_text() {
        let error = parse("/usagee").unwrap_err();
        match error {
            CommandError::Unknown { name, suggestions } => {
                assert_eq!(name, "usagee");
                assert!(
                    suggestions.contains(&"/usage".to_owned()),
                    "{suggestions:?}"
                );
            }
            other => panic!("expected Unknown, got {other}"),
        }
        assert!(matches!(
            parse("not a command"),
            Err(CommandError::NotACommand)
        ));
    }

    #[test]
    fn malformed_arguments_are_refused_with_the_grammar() {
        let error = parse("/insights --days nope").unwrap_err();
        match error {
            CommandError::Malformed { id, schema, .. } => {
                assert_eq!(id, "insights");
                assert_eq!(schema, "[--days N]");
            }
            other => panic!("expected Malformed, got {other}"),
        }
        assert!(matches!(
            parse("/usage extra"),
            Err(CommandError::Malformed { id: "usage", .. })
        ));
        assert!(matches!(
            parse("/help too many words"),
            Err(CommandError::Malformed { id: "help", .. })
        ));
    }

    #[test]
    fn help_and_search_come_from_the_registry() {
        let listing = render_help(None).unwrap();
        for descriptor in registry() {
            assert!(listing.contains(descriptor.id), "{} missing", descriptor.id);
        }
        let usage = render_help(Some("usage")).unwrap();
        assert!(usage.contains("CMP-analytics"));
        assert!(render_commands(Some("analytics")).contains("/usage"));
        assert!(render_commands(Some("analytics")).contains("/insights"));
        assert!(
            !render_commands(Some("analytics")).contains("  /help "),
            "the filtered list must not include help as a row"
        );
        assert!(matches!(
            render_help(Some("nope")),
            Err(CommandError::Unknown { .. })
        ));
    }

    #[test]
    fn completion_comes_from_the_registry() {
        assert_eq!(complete("u"), vec!["usage"]);
        assert_eq!(complete("he"), vec!["help"]);
        assert!(complete("zz").is_empty());
        assert_eq!(complete(""), vec!["commands", "help", "insights", "usage"]);
    }

    #[test]
    fn a_surface_that_may_not_offer_a_command_gets_a_typed_refusal() {
        assert!(matches!(
            parse_on("/usage", Surface::Tui),
            Err(CommandError::UnsupportedSurface {
                id: "usage",
                surface: Surface::Tui
            })
        ));
    }
}
