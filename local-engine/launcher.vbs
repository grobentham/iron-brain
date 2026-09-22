Option Explicit
Dim fso, shell, engineDir, rootDir, nodePath, serverPath, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
engineDir = fso.GetParentFolderName(WScript.ScriptFullName)
rootDir = fso.GetParentFolderName(engineDir)
nodePath = rootDir & "\runtime\node.exe"
serverPath = engineDir & "\server.mjs"
If Not fso.FileExists(nodePath) Then
  WScript.Quit 2
End If
If Not fso.FileExists(serverPath) Then
  WScript.Quit 3
End If
cmd = Chr(34) & nodePath & Chr(34) & " " & Chr(34) & serverPath & Chr(34)
shell.Run cmd, 0, False
