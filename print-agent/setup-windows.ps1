$ErrorActionPreference = "Stop"

$Host.UI.RawUI.WindowTitle = "ALO Print Agent Setup"

Write-Host ""
Write-Host "========================================"
Write-Host "       ALO PRINT AGENT - SETUP"
Write-Host "========================================"
Write-Host ""

$AgentDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $AgentDir

Write-Host "[1/6] Windows wird geprueft..."

if (-not $IsWindows -and $PSVersionTable.PSEdition -eq "Core") {
    Write-Host "FEHLER: Dieses Setup ist nur fuer Windows."
    Read-Host "Enter zum Beenden"
    exit 1
}

Write-Host "OK - Windows erkannt."
Write-Host ""

# ----------------------------------------------------------
# NODE.JS
# ----------------------------------------------------------

Write-Host "[2/6] Node.js wird geprueft..."

$NodeCommand = Get-Command node -ErrorAction SilentlyContinue

if (-not $NodeCommand) {
    Write-Host ""
    Write-Host "Node.js wurde nicht gefunden."
    Write-Host "Versuche Node.js automatisch zu installieren..."
    Write-Host ""

    $WingetCommand = Get-Command winget -ErrorAction SilentlyContinue

    if (-not $WingetCommand) {
        Write-Host "FEHLER: winget wurde nicht gefunden."
        Write-Host "Bitte Node.js LTS installieren und Setup erneut starten."
        Read-Host "Enter zum Beenden"
        exit 1
    }

    winget install OpenJS.NodeJS.LTS `
        --accept-package-agreements `
        --accept-source-agreements

    $NodePaths = @(
        "C:\Program Files\nodejs",
        "C:\Program Files (x86)\nodejs"
    )

    foreach ($NodePath in $NodePaths) {
        if (Test-Path $NodePath) {
            $env:Path = "$NodePath;$env:Path"
        }
    }

    $NodeCommand = Get-Command node -ErrorAction SilentlyContinue

    if (-not $NodeCommand) {
        Write-Host ""
        Write-Host "Node.js wurde installiert."
        Write-Host "Windows Terminal muss eventuell neu gestartet werden."
        Read-Host "Enter zum Beenden"
        exit 0
    }
}

$NodeVersion = node --version

Write-Host "OK - Node.js $NodeVersion"
Write-Host ""

# ----------------------------------------------------------
# SUMATRAPDF
# ----------------------------------------------------------

Write-Host "[3/6] PDF-Drucksystem wird geprueft..."

$SumatraCandidates = @(
    "$AgentDir\SumatraPDF.exe",
    "C:\Program Files\SumatraPDF\SumatraPDF.exe",
    "C:\Program Files (x86)\SumatraPDF\SumatraPDF.exe",
    "$env:LOCALAPPDATA\SumatraPDF\SumatraPDF.exe"
)

$SumatraFound = $false

foreach ($Candidate in $SumatraCandidates) {
    if ($Candidate -and (Test-Path $Candidate)) {
        $SumatraFound = $true
        Write-Host "OK - SumatraPDF gefunden:"
        Write-Host $Candidate
        break
    }
}

if (-not $SumatraFound) {
    Write-Host ""
    Write-Host "SumatraPDF wurde nicht gefunden."
    Write-Host "Versuche SumatraPDF automatisch zu installieren..."
    Write-Host ""

    $WingetCommand = Get-Command winget -ErrorAction SilentlyContinue

    if ($WingetCommand) {
        try {
            winget install SumatraPDF.SumatraPDF `
                --accept-package-agreements `
                --accept-source-agreements
        }
        catch {
            Write-Host "Automatische Installation war nicht erfolgreich."
        }
    }

    Start-Sleep -Seconds 2

    foreach ($Candidate in $SumatraCandidates) {
        if ($Candidate -and (Test-Path $Candidate)) {
            $SumatraFound = $true
            Write-Host "OK - SumatraPDF installiert."
            break
        }
    }

    if (-not $SumatraFound) {
        Write-Host ""
        Write-Host "WARNUNG: SumatraPDF wurde noch nicht gefunden."
        Write-Host "Der Agent wird keine Print-Jobs uebernehmen,"
        Write-Host "bis SumatraPDF vorhanden ist."
    }
}

Write-Host ""

# ----------------------------------------------------------
# KONFIGURATION
# ----------------------------------------------------------

Write-Host "[4/6] ALO Konfiguration wird geprueft..."

$EnvFile = Join-Path $AgentDir ".env"

$ExistingToken = $null

if (Test-Path $EnvFile) {
    $TokenLine = Get-Content $EnvFile |
        Where-Object { $_ -match '^PRINT_AGENT_TOKEN=' } |
        Select-Object -First 1

    if ($TokenLine) {
        $ExistingToken = $TokenLine.Substring(
            "PRINT_AGENT_TOKEN=".Length
        ).Trim()
    }
}

if (-not $ExistingToken) {
    Write-Host ""
    Write-Host "Der Print-Agent muss einmalig mit ALO verbunden werden."
    Write-Host ""
    Write-Host "PRINT_AGENT_TOKEN eingeben."
    Write-Host "Die Eingabe wird nicht angezeigt."
    Write-Host ""

    $SecureToken = Read-Host "Token" -AsSecureString

    $BSTR = [Runtime.InteropServices.Marshal]::SecureStringToBSTR(
        $SecureToken
    )

    try {
        $PlainToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR(
            $BSTR
        )
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($BSTR)
    }

    if ([string]::IsNullOrWhiteSpace($PlainToken)) {
        Write-Host "FEHLER: Kein Token eingegeben."
        Read-Host "Enter zum Beenden"
        exit 1
    }

    @"
ALO_BACKEND_URL=https://alo-platform-production.up.railway.app
PRINT_AGENT_TOKEN=$PlainToken
"@ | Set-Content -Path $EnvFile -Encoding UTF8

    Write-Host ""
    Write-Host "OK - Verbindungskonfiguration gespeichert."
}
else {
    Write-Host "OK - ALO Verbindung ist bereits konfiguriert."
}

Write-Host ""

# ----------------------------------------------------------
# DRUCKER
# ----------------------------------------------------------

Write-Host "[5/6] Installierte Windows-Drucker werden gesucht..."
Write-Host ""

try {
    $Printers = Get-Printer |
        Select-Object Name, DriverName, PortName

    if (-not $Printers) {
        Write-Host "WARNUNG: Kein Drucker gefunden."
        Write-Host ""
        Write-Host "Brother QL-1110NWB anschliessen und"
        Write-Host "Brother-Treiber installieren."
    }
    else {
        foreach ($Printer in $Printers) {
            Write-Host "----------------------------------------"
            Write-Host "Drucker: $($Printer.Name)"
            Write-Host "Treiber: $($Printer.DriverName)"
            Write-Host "Port:    $($Printer.PortName)"
        }

        Write-Host "----------------------------------------"
    }
}
catch {
    Write-Host "WARNUNG: Druckerliste konnte nicht gelesen werden."
    Write-Host $_.Exception.Message
}

Write-Host ""

# ----------------------------------------------------------
# STARTDATEI ERSTELLEN
# ----------------------------------------------------------

Write-Host "[6/6] Startdatei wird erstellt..."

$StartFile = Join-Path $AgentDir "ALO-Print-Agent.cmd"

$StartContent = @"
@echo off
title ALO Print Agent
cd /d "%~dp0"

echo.
echo ======================================
echo           ALO PRINT AGENT
echo ======================================
echo.

where node >nul 2>nul

if errorlevel 1 (
    echo FEHLER: Node.js wurde nicht gefunden.
    echo Bitte setup-windows.ps1 erneut ausfuehren.
    echo.
    pause
    exit /b 1
)

node src\index.js

echo.
echo Der ALO Print Agent wurde beendet.
pause
"@

Set-Content `
    -Path $StartFile `
    -Value $StartContent `
    -Encoding ASCII

Write-Host "OK - ALO-Print-Agent.cmd erstellt."
Write-Host ""

Write-Host "========================================"
Write-Host "          SETUP ABGESCHLOSSEN"
Write-Host "========================================"
Write-Host ""
Write-Host "Computer:"
Write-Host $env:COMPUTERNAME
Write-Host ""
Write-Host "Morgen:"
Write-Host "1. Brother QL-1110NWB verbinden"
Write-Host "2. Brother Windows-Treiber installieren"
Write-Host "3. ALO-Print-Agent.cmd starten"
Write-Host "4. Shopify -> ALO Platform -> Drucker pruefen"
Write-Host "5. SPECIMEN-Testetikett drucken"
Write-Host ""
Write-Host "WICHTIG: Swiss Post bleibt vorerst im SPECIMEN-Modus."
Write-Host ""

Read-Host "Enter zum Beenden"
