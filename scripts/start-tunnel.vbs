' dsh-remote — start a Cloudflare quick tunnel silently.
Option Explicit
Dim sh, fso, here, repo, exe, logFile, errFile, cmd
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
repo = fso.GetParentFolderName(here)
exe = repo & "\bin\cloudflared.exe"
logFile = repo & "\gateway\tunnel.log"
errFile = repo & "\gateway\tunnel.err.log"
cmd = "cmd /c """"" & exe & """ tunnel --url http://127.0.0.1:8787 --no-autoupdate --protocol http2 > """ & logFile & """ 2> """ & errFile & """"""
sh.Run cmd, 0, False
