ALO KIOSK – PRINT AGENT
=======================

ERSTE EINRICHTUNG

1. Brother QL-1110NWB mit dem Windows-PC verbinden.

2. Brother QL-1110NWB Windows-Treiber installieren.

3. Prüfen, ob der Drucker unter:
   Windows > Einstellungen > Bluetooth & Geräte > Drucker & Scanner
   sichtbar ist.

4. PowerShell im ALO-Print-Agent-Ordner öffnen.

5. Einmalig ausführen:

   powershell -ExecutionPolicy Bypass -File .\setup-windows.ps1

6. Falls nach dem PRINT_AGENT_TOKEN gefragt wird:
   den ALO Print-Agent Token eingeben.
   Der Token darf nicht weitergegeben werden.

7. Setup vollständig durchlaufen lassen.

8. Danach ALO-Print-Agent.cmd doppelklicken.

9. Das Fenster des Print Agents während des Betriebs geöffnet lassen.

10. In Shopify öffnen:

    Apps
    > ALO Platform
    > Drucker

11. Prüfen:
    - Railway verbunden
    - Brother-Drucker erkannt
    - Drucker ONLINE

12. Danach ausschließlich mit einem
    Swiss Post SPECIMEN-Testetikett testen.

WICHTIG
=======

Swiss Post NICHT auf LIVE umstellen.

Wenn mehrere Drucker installiert sind und der Brother nicht
automatisch gewählt wird, zuerst keinen Versandauftrag starten.

Der Agent übernimmt einen Print-Job erst, wenn:
- Windows erkannt wurde
- ein geeigneter Drucker gewählt wurde
- SumatraPDF verfügbar ist
- die Railway-Verbindung funktioniert

Bei erfolgreichem Druck meldet der Agent den Job als PRINTED.

Bei einem Druckfehler meldet der Agent den Job als FAILED.

ALO KIOSK
Shipping & Fulfillment Platform
