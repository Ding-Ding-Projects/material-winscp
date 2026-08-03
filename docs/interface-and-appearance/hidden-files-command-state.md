# Hidden-file visibility command state

`ShowHiddenFilesAction` is enabled only when the workspace service is present.
The command changes the persisted `showHiddenFiles` preference and then asks
every live file panel to repaint. A preview or headless renderer has no panels,
so it must expose the action as unavailable rather than presenting a toggle
that changes a setting without changing any visible directory.

The state is derived from the command registry's workspace capability. When the
workspace is installed, the action remains a toggle and applies the new value
to every panel. When it is absent, the normal unavailable reason explains that
the application process is not connected.

Verification: `node --test test/commands.test.js` covers the no-workspace state
alongside the complete 301-action registry contract.
