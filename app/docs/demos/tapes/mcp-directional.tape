# One-way MCP mirror with the guarded confirmation: preview the diff with --dry-run,
# then apply with --yes (writes a .syncthis.bak first). Live against the sandbox HOME.
Output docs/demos/out/mcp-directional.gif

Set Shell bash
Set FontSize 16
Set Width 1180
Set Height 720
Set Padding 18
Set TypingSpeed 55ms

Hide
Type "export PS1='$ '"
Enter
Type "clear"
Enter
Show

Sleep 500ms
Type "syncthis mcp claude-code cursor --dry-run"
Sleep 400ms
Enter
Sleep 3s
Type "syncthis mcp claude-code cursor --yes"
Sleep 400ms
Enter
Sleep 3s
