# Aculife-IB Portal

The International Business portal, with three programs in one site:

* **Approval Note**: a region raises the note, an Admin approves it, the note is printed, the CEO signs it on paper, the **signed scan is uploaded** (PDF/JPG/PNG), and the Super-admin records the final approval.
* **Priority Sheet**: each distributor or RA has **several task lines**, and each task has its own **TCD**. When a TCD changes, the old date and the reason are kept. Regions post a **daily update** on each task, all on one screen with the **Today's update** button. Everyone can **download the sheet as Excel**: one sheet per region plus a summary showing who updated today and which TCDs are overdue.
* **Price Approval**: reserved, and will be enabled when the format is shared.

Every region signs in with its **own Login ID and password** and can only see and change its **own region's** data. The server checks this, so a region cannot see another region's data even by changing the web address.

---

## Put it on the web (about 20 minutes, no IT team needed)

You need two free accounts: **GitHub**, which stores the code, and **Render**, which runs the website and the database.

### 1. Upload the code to GitHub
1. Create a free account at https://github.com and sign in.
2. Click **+** (top right) → **New repository**. Name it `aculife-ib-portal`, choose **Private**, and click **Create repository**.
3. On the next page click **uploading an existing file**.
4. Unzip `aculife-ib-portal.zip` on your computer. Drag **everything inside the folder** into the GitHub page: `server.js`, `package.json`, `package-lock.json`, `render.yaml`, `README.md`, `.gitignore`, and the `public` and `seed` folders.
5. Click **Commit changes**.

### 2. Create the website on Render
1. Go to https://render.com and click **Get Started**. Sign up **with your GitHub account**.
2. In Render click **New +** → **Blueprint**.
3. Connect your GitHub and pick the `aculife-ib-portal` repository.
4. Render reads `render.yaml` and shows two items: the web service **aculife-ib** and the database **aculife-ib-db**.
5. It asks for **ADMIN_PASSWORD**. Type a strong password of at least 10 characters. This is the Super-admin password for login ID **ADMIN**.
6. Add a payment card if asked, then click **Apply**. The first build takes 3–5 minutes.

### 3. Open your portal
* When the status shows **Live**, the address appears at the top, for example `https://aculife-ib.onrender.com`.
* Open it and sign in with **ADMIN** and the password you set.
* Go to **Login IDs & Access** → **Create IDs for all regions**. Copy the list and send each region its own ID and password.
* Each region user opens the same address and signs in. No other account is needed.

### Cost
| Item | Plan in `render.yaml` | Approx. cost |
|---|---|---|
| Website | Starter (always on) | ~$7 / month |
| Database | Basic-256mb (with daily backups) | ~$6 / month |

**Free trial option:** in `render.yaml` change `plan: starter` to `plan: free` and `plan: basic-256mb` to `plan: free`. Be aware of two limits:
* The free website goes to sleep after 15 minutes without use, and the next visit then takes about a minute to open.
* The free database is **deleted after 30 days** unless you upgrade it.

Use the free plans for testing only.

### Use your own web address later
In Render open **aculife-ib → Settings → Custom Domains**, add for example `ib.aculife.com`, and ask whoever manages the Aculife domain to add the DNS record Render shows. HTTPS is set up automatically.

---

## Day-to-day admin
* **Forgot password (region):** Login IDs & Access → **Reset password**, then send the new password.
* **Someone leaves:** **Disable** or **Delete** their Login ID. They are signed out immediately.
* **Change your own password:** **Change password** at the bottom left.
* **Add a person to a region, or another approver:** **+ Add login ID**. Choose *Region user* or *Admin*.
* **Regions and countries:** the **Regions & Countries** page. It was loaded from the Region Master sheet.
* **Daily Priority Sheet discipline:** the Priority Sheet shows *“X / Y open tasks updated today”*. Tick **Not updated today** to see what is still pending. The Excel **Summary** sheet shows the same for every region.
* **Signed scans** are stored safely in the database. Only users who can see that region can open them.

## Roles
| Role | Sees | Can do |
|---|---|---|
| Super-admin (ADMIN) | All regions | Everything, plus manage Login IDs, regions and countries, and record the CEO's final approval |
| Admin | All regions | Approve, return or reject notes; update any region's data |
| Region user | Own region only | Raise approval notes; fill in and update the Priority Sheet |

## Technical notes (for IT)
* Node.js 18+, Express and PostgreSQL. The only required environment variable is `DATABASE_URL`. `ADMIN_LOGIN` and `ADMIN_PASSWORD` are used **only on first start**, to create the Super-admin.
* Passwords are hashed with bcrypt. Sessions use HTTP-only secure cookies and last 7 days. Sign-in attempts are rate-limited. Pasted content in notes is cleaned on the server (HTML sanitising).
* Run locally: `npm install`, then `npm start`. Without `DATABASE_URL` it uses a temporary in-memory database for testing.
* It also runs on Railway, Azure App Service, AWS or any host that runs Node.js with PostgreSQL.
