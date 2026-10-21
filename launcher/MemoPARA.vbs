' MemoPARA - inicia o servidor local (sem janela de console) e abre o app em janela propria.
' Se o servidor ja estiver rodando, apenas abre a janela.
Option Explicit

Const PORT = 5060
Dim sh, fso, root, url, dataDir, logPath, i

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
url = "http://127.0.0.1:" & PORT & "/"
dataDir = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\MemoPARA"
logPath = dataDir & "\server.log"

If Not IsUp() Then
  If sh.Run("cmd /c where node >nul 2>&1", 0, True) <> 0 Then
    MsgBox "O Node.js nao foi encontrado neste computador." & vbCrLf & vbCrLf & _
      "Instale a versao LTS em https://nodejs.org (22 ou mais recente) e abra o MemoPARA novamente.", 16, "MemoPARA"
    WScript.Quit 1
  End If
  If Not fso.FolderExists(dataDir) Then fso.CreateFolder dataDir
  sh.CurrentDirectory = root
  sh.Run "cmd /c node --disable-warning=ExperimentalWarning ""src\server.js"" --port " & PORT & " --auto-exit >> """ & logPath & """ 2>&1", 0, False
  For i = 1 To 80
    WScript.Sleep 250
    If IsUp() Then Exit For
  Next
  If Not IsUp() Then
    MsgBox "O servidor do MemoPARA nao respondeu." & vbCrLf & "Veja o log em:" & vbCrLf & logPath, 48, "MemoPARA"
    WScript.Quit 1
  End If
End If

OpenWindow url

Function IsUp()
  Dim http
  IsUp = False
  On Error Resume Next
  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  http.setTimeouts 500, 500, 1000, 1000
  http.Open "GET", url & "api/health", False
  http.Send
  If Err.Number = 0 Then
    If http.Status = 200 And InStr(http.responseText, "MemoPARA") > 0 Then IsUp = True
  End If
  On Error GoTo 0
End Function

Sub OpenWindow(target)
  ' Edge/Chrome em modo "--app" abre como um aplicativo, sem abas nem barra de endereco.
  Dim candidates, c
  candidates = Array( _
    sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Microsoft\Edge\Application\msedge.exe", _
    sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\Microsoft\Edge\Application\msedge.exe", _
    sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\Google\Chrome\Application\chrome.exe", _
    sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Google\Chrome\Application\chrome.exe")
  For Each c In candidates
    If fso.FileExists(c) Then
      sh.Run """" & c & """ --app=" & target & " --window-size=1360,900", 1, False
      Exit Sub
    End If
  Next
  sh.Run target, 1, False
End Sub
