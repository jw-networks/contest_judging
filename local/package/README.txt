SPOTLIGHT LOCAL SERVER
======================

Run Spotlight on your own network, with no internet needed. One computer (a laptop or
mini-PC) runs the server; every tablet, phone and laptop on the same Wi-Fi opens it in a
web browser. Scores, check-in, photos and the stage clock all sync through that computer.

WHAT YOU NEED
  - A Windows, Mac or Linux computer that stays on during the event, on the event Wi-Fi.
    Plug it in to power and turn off sleep.
  - Node.js, free from https://nodejs.org (choose the LTS version; 22.13 or newer).
  - A Wi-Fi network. It doesn't need internet. A travel router works well.
    Avoid "guest" networks: they often stop devices from seeing each other.

START IT
  Windows:  double-click  "Start Spotlight (Windows).bat"
            If Windows asks whether Node.js may use the network, tick Private networks, Allow.
  Mac:      double-click  "Start Spotlight (Mac).command"
            The first time, macOS may refuse to open it: right-click it, choose Open, then Open.
            If macOS asks whether node may accept incoming connections, click Allow.
  Linux:    ./start-linux.sh
  Docker:   see Dockerfile.

  A window opens showing the address to use, for example  http://192.168.1.20:8787 ,
  and (the first time only) the admin password. Keep that window open during the event.

ON EACH DEVICE
  Open that address in the browser (Safari, Chrome or Edge). Sign in. That's it.
  Tip: add it to the home screen for a full-screen app.
  Open the confidence monitor from Stage control on the computer driving the stage screen.

YOUR DATA
  Everything is saved in the "spotlight-data" folder next to these files:
    spotlight.db       the live database
    backups/           a full copy every 5 minutes and when the server stops (last 48 kept)
  To move to another computer, stop the server and copy the whole spotlight-data folder.
  The backups contain password hashes: keep this folder private.

GOOD TO KNOW
  - Each tablet also keeps its own scores, so if Wi-Fi drops, judges keep scoring and the
    scores send when the connection is back. Keep the app open on each tablet rather than
    closing the browser while the server is unreachable (over plain http, browsers don't
    keep an offline copy of the app itself).
  - The computer's address can change if it reconnects to Wi-Fi. If devices can't connect,
    look at the server window for the current address. A fixed address (DHCP reservation)
    on your router avoids this.
  - Use a different port:  node local/server.mjs --port 8788
  - Optional HTTPS: put cert.pem and key.pem in spotlight-data and restart.
  - Optional cloud backup: set DATA_REPO (owner/repo) and DATA_REPO_TOKEN before starting to
    also copy the data to a private GitHub repo whenever the computer has internet.

MOVING CONTESTS FROM AND TO THE ONLINE VERSION
  This is a separate copy from the online version of Spotlight. To carry contests across,
  use Admin -> Transfer contests on both sides:
    1. Online, before the event: tick the contests and press "Download transfer file".
    2. Here: "Choose transfer file...", check the preview, type IMPORT. Contests, entries,
       photos, scores and the accounts (with their passwords) all come across.
    3. After the event: download a transfer file here and load it online the same way.
  Loading replaces those contests on the receiving side, so stop scoring on the other side
  first. The file contains password hashes: keep it private and delete it afterwards.
