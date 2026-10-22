import { useDialog } from "../../ui/dialog"
import { DialogSelect } from "../../ui/dialog-select"
import { DialogEditorSettings } from "../../component/dialog-editor-settings"
import { DialogRepoIntelligenceSettings } from "../../component/dialog-repo-intelligence"

/** Settings surfaces available from the session-level `/settings` command. */
export function DialogSessionSettings(props: { readonly sessionID: string }) {
  const dialog = useDialog()
  return (
    <DialogSelect
      title="Settings"
      flat
      options={[
        {
          title: "Editors",
          value: "editors",
          category: "Session",
          description: "Choose a user-owned editor profile for explicit /editor actions.",
          onSelect: () => dialog.replace(() => <DialogEditorSettings sessionID={props.sessionID} />),
        },
        {
          title: "RepoIntel",
          value: "repo-intelligence",
          category: "Workspace",
          description: "Choose the requested local repository analysis profile.",
          onSelect: () => dialog.replace(() => <DialogRepoIntelligenceSettings />),
        },
      ]}
    />
  )
}
