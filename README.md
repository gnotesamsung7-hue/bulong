# Bulong — Bluetooth messenger

Chat with people around you with **no internet and no cell signal**. Phones link up by themselves over Bluetooth and pass messages along to each other (a mesh), so messages can reach people farther than one phone's range.

- **Private 1-on-1 chats**: end-to-end encrypted. Phones that relay a message can't read it. ✓ = sent to a nearby phone, ✓✓ = delivered.
- **Group chats**: encrypted; others join by scanning the group's QR code (or pasting the invite text).
- **Store and forward**: if nobody is in range, the message waits (🕓) and goes out as soon as a phone with Bulong comes near.
- **Safety code** (🔒 Code in a chat): compare it face to face to be sure nobody is pretending to be your friend.
- Version number on the start screen, and a QR code in **Me** to share the app.

## How the parts fit

| Folder | What it is |
|---|---|
| `www/` | The app itself: `index.html` (screens) and `mesh.js` (relay, encryption, chats) |
| `android/` | Android wrapper. `BulongMeshPlugin.java` talks to Bluetooth (Google Nearby Connections) |
| `docs/` | Download page + printable QR card (GitHub Pages) |
| `.github/workflows/main.yml` | Builds the signed APK on GitHub and publishes it to Releases |

## One-time setup (all in the browser, nothing to install)

1. **Create the repo**: on GitHub click **+ → New repository**, name it `bulong`, set it **Public**, leave **Add a README** unticked, click **Create repository**.
2. **Upload the files**: on the empty repo page click **uploading an existing file**. Unzip `bulong-repo.zip` on your laptop, open the `bulong` folder, select **everything inside it** and drag it into the page. Click **Commit changes**.
3. **Add the workflow** (GitHub's uploader can skip folders that start with a dot, so do this by hand): click **Add file → Create new file**, type the name `.github/workflows/main.yml`, paste the contents of `main.yml` from the zip, click **Commit changes**.
4. **Add the 4 signing secrets**: **Settings → Secrets and variables → Actions → New repository secret**. Copy each name and value from `github-secrets-bulong.txt` (sent separately, *not* in the repo).
5. **Build**: go to the **Actions** tab. The build starts by itself after step 3 (or click **Build Bulong APK → Run workflow**). It takes about 5 minutes. When it's green, the APK is under **Releases** on the repo's main page.
6. **Download page + printable card**: **Settings → Pages → Source: Deploy from a branch → Branch: `main`, folder: `/docs` → Save**. After a minute it's at
   `https://gnotesamsung7-hue.github.io/bulong/` (has a **Print QR card** button).

The QR code in the app and on the card always points to the newest build:
`https://github.com/gnotesamsung7-hue/bulong/releases/latest/download/Bulong.apk`

## Updating the app later

Change the files in `www/`, bump `APP_VERSION` near the top of the script in `www/index.html` (e.g. `'1.0.1'`), commit. GitHub builds and publishes the new APK automatically. Keep `bulong-release.jks` and the secrets file backed up: without them, updates can't install over the existing app.

## Good to know

- Phones need **Google Play services** (almost all Android phones; not newer Huawei).
- On first open, allow **Nearby devices** (Android 12 and newer) or **Location** (Android 11 and older), and turn Bluetooth on.
- Each phone links to up to 4 others; announcements reach about 5 phone-hops, messages up to 10.
- Keep Bulong open (it can be in the background for a while). If Android fully closes the app, that phone stops relaying until it's opened again.
- Nearby Connections may switch to Wi-Fi Direct between two phones for speed. It still needs no internet or router.
