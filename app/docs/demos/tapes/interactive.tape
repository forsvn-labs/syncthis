# The interactive picker: clean three-noun menu, then a guided read-only flow showing the
# new breadcrumb + "what this does" header. Navigates MCPs → Check problems (read-only).
Output docs/demos/out/interactive.gif

Set Shell bash
Set FontSize 16
Set Width 1180
Set Height 820
Set Padding 18
Set TypingSpeed 55ms

Hide
Type "export PS1='$ '"
Enter
Type "clear"
Enter
Show

Sleep 500ms
Type "syncthis"
Sleep 400ms
Enter
Sleep 3s

# Move down to "Manage MCPs" and enter.
Down
Sleep 700ms
Down
Sleep 700ms
Enter
Sleep 1.5s

# In the MCP menu, drop to "Check problems" (read-only) to show the breadcrumb header.
Down
Sleep 500ms
Down
Sleep 500ms
Down
Sleep 500ms
Down
Sleep 500ms
Enter
Sleep 3s

Ctrl+C
Sleep 1s
