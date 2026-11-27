# WAHA backend application context

Updated 28 November 2026.

This Node.js service connects a browser frontend to WhatsApp through WAHA (WhatsApp HTTP API). WAHA can hold several sessions, each paired to one of the business's WhatsApp numbers. The **main number** is the session named by `WAHA_SESSION`; every other connected session is a further inbox the frontend can switch to. The backend authenticates a configured super user, delegated admins and regular chat users, forwards selected requests with a server-held WAHA API key, and converts live WAHA events into a browser-readable stream. WAHA owns the WhatsApp sessions, messages, labels and files. The backend stores accounts, number assignments, requirements and large outbound broadcasts in SQLite, and runs a single background broadcast worker per process.

**Names in the UI.** The frontend calls a WAHA session a **WA number** (tabs **Assign WA Num** and **Add Number**). It calls a WhatsApp Business label a **campaign** in the chat, and the requirements grid **Whatix AI**. The backend keeps the original names: sessions, `campaign_grants` (a user's access to a number), labels and `"offline requirements"`.

## Running and configuring the service

From the backend directory, use Node.js 20.17 or newer (CI uses 22), install locked dependencies with `npm ci`, and start the service with `npm start`. For development, `npm run dev` restarts Node on source changes. Both commands run `src/server.js`, which defines the HTTP server. Account storage is in `src/accounts.js`, number assignments in `src/campaigns.js` and `src/campaign-access.js`, and number management in `src/numbers.js`. `package.json` declares the commands and dependencies, and `package-lock.json` pins the dependency tree. `.github/workflows/ci.yml` runs `npm ci`, `npm test` and `npm audit --omit=dev --audit-level=high` on every push to `main` and every pull request.

| Setting | Behavior |
| --- | --- |
| `PORT` | Defaults to 8080. Both local and example environments specify 8080. The HTTP listener binds all IPv4 interfaces. The sibling Vite development server listens on 5173 and proxies `/api` to `http://127.0.0.1:8080`. |
| `WAHA_URL`, `WAHA_SESSION` | Default to `http://127.0.0.1:3000` and `TEST_BULK`. `WAHA_SESSION` is the main number; other sessions in WAHA are found at runtime. The same base URL drives HTTP and WebSocket access. |
| `WAHA_DASHBOARD_USERNAME`, `WAHA_DASHBOARD_PASSWORD` | Optional. Basic-auth login the backend sends to WAHA's bundled dashboard when admins open the **Add Number** tab. The username defaults to `admin`. Without a password, the browser's own Basic-auth header is passed on. |
| `WAHA_API_KEY` | Required. Sent to WAHA in the HTTP `X-Api-Key` header or the server-side WebSocket query string. Redact that query string from proxy logs. |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | Identifies the sole account with the `super_user` role. The local configuration uses `super_user`; the code fallback username is `admin`. The bootstrap password is required when creating or migrating a workbook. Production rejects the literal default password unless `ALLOW_INSECURE_DEMO_CREDENTIALS=true`. |
| `WHATIX_DB_PATH` | SQLite database path. Defaults to `whatix.db` beside the legacy account workbook, normally `data/whatix.db`. |
| `WHATIX_PASSWORD_SECRET` | Stable secret used to derive the AES key for account password verifiers. Defaults to `JWT_ACCESS_SECRET` at startup. Back up the effective secret with the database in separate secure storage. |
| `USER_WORKBOOK_PATH`, `ASSIGNED_NUMBERS_PATH` | Sources for the one-time import. Defaults are `data/users.xlsx` and `assigned_numbers.xlsx` beside it. |
| `OLLAMA_MODEL`, `OLLAMA_BASE_URL` | Setting a model enables offline intake. The local configuration uses `qwen3:4b` served by Ollama. The base URL defaults to `http://localhost:11434`. |
| `AWAY_REPLIES_ENABLED` | Paused by default. Set to `true` with `OLLAMA_MODEL` configured and reload the backend to resume offline replies. **Keep it off:** the owner disabled the AI replies on purpose. |
| `BUSY_REPLIES_ENABLED`, `BUSY_REPLY_DELAY_SECONDS`, `BUSY_FOLLOWUP_GAP_SECONDS`, `BUSY_ENGAGED_SECONDS`, `BUSY_REPLY_COOLDOWN_SECONDS` | Delayed holding replies are paused by default and, like the AI replies, are deliberately kept off. Set `BUSY_REPLIES_ENABLED=true` and reload the backend to resume. The defaults are 60 seconds before a holding reply, 300 seconds between the holding reply and a follow-up, 600 seconds of engagement after attendance, and 1,800 seconds between further follow-ups. |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | Required, distinct, and at least 32 characters each. The startup check compares lengths and equality only. |
| `FRONTEND_ORIGIN` | Exact browser origin allowed for credentialed CORS. Defaults to `http://localhost:5173`. Outside production, any `localhost` or `127.0.0.1` port is also accepted so local test copies work. |
| `NODE_ENV`, `TRUST_PROXY` | Production enables Secure cookies. `TRUST_PROXY=1` trusts one proxy hop for client IP identification. Restrict direct access if enabling it. |
| `APP_USERS_JSON` | Optional legacy account list, read only by the one-time import. Test backends use it to seed throwaway accounts. |

The service loads `.env` via dotenv at startup. Use HTTPS at the browser-facing reverse proxy. Login sends Base64-encoded JSON, which offers no transport confidentiality.

**Testing a second copy locally.** Browsers keep cookies per host, not per port. A test backend and frontend on `localhost` overwrite the `wa_access` and `wa_refresh` cookies of the real app on `localhost:5173`/`8080`, and both copies keep signing each other out ("invalid signature"). Run test copies on `127.0.0.1` instead.

## SQLite storage and VPS deployment

On the first startup, the backend imports the three workbooks in one SQLite transaction, including their ID high-water marks and hidden intake context. It also imports broadcast jobs and payloads, sent-message ownership, personal chat removals, label changes and away-reply markers. A failed import rolls back and can be retried. After migration, the database schema version identifies the completed import. Old source files can be kept as private backups. Excel uploads for label previews are still processed in memory.

For a VPS cutover, stop the old Whatix backend before taking the final copy of `data/whatix.db`. Transfer it privately, set the same effective password secret and WhatsApp session configuration, and run `npm ci --omit=dev` on the host. Give the service account write access to the database directory for SQLite's transaction journals. Start one backend instance and check `/api/health` and login. For a running service, use SQLite's backup facility to take a consistent backup.

**Schema versions.** `PRAGMA user_version` records the schema. `src/whatix.js` upgrades an older database at startup, one step at a time, using the SQL in `src/sqlite.js`:

| Version | Adds |
| --- | --- |
| 1 | The imported tables: `users`, `assigned_numbers`, `"offline requirements"`, `intake_context`, `app_records`, `away_replies`. |
| 2 | Number assignments: `campaign_grants (session, campaign_phone, user_id)`, `campaign_grant_labels` and `campaign_contacts`. |
| 3 | `assigned_at` and `assigned_by` on grants and contacts (who assigned, and when). |
| 4 | Index `requirements_received` for the paged requirements grid. |
| 5 | `labels_limited` on grants: 0 means the user sees every label on that number, 1 limits them to `campaign_grant_labels`. |
| 6 | `RECEIVED_SESSION` and `RECEIVED_BY` on `"offline requirements"`: which of our numbers received the requirement (session name and its phone at the time), with an index. |
| 7 | `MUST_CHANGE_PASSWORD` on `users` (0 or 1, default 0): the account must choose its own password at the next sign-in. Existing accounts keep 0. |

Before upgrading an existing file, the backend writes a consistent copy beside it with `VACUUM INTO`, named `whatix.db.pre-v<N>-<time>.bak`. A database newer than this code refuses to start. On the VPS, `deploy/backup.sh` (run nightly at 02:30 by `whatix-backup.timer`) takes an integrity-checked online copy of the database, compresses it, can encrypt it with `age` and copy it off the server, and prunes old copies (14 days by default). It can also back up the WAHA session volume so paired numbers survive a rebuild. Settings go in `/etc/whatix-backup.env`.

If the database was initialized using the JWT fallback, set `WHATIX_PASSWORD_SECRET` to the **previous** access secret before rotating `JWT_ACCESS_SECRET`. A new random password secret would require re-encrypting the account verifiers. WAHA remains the source of WhatsApp chat content and labels. Browser-specific caches and short-lived login sessions keep their existing lifecycles.

## Accounts

All logins, including the configured super user, verify the account in the SQLite `users` table. The columns are `ID, NAME, USER_NAME, PASSWORD, BAN_LOGIN, DATE_CREATED, USER_IP, PHONE_NUMBER, IS_ADMIN`. Registration assigns the next numeric ID using a persisted high-water mark, stamps the creation date, and defaults both flags to false. Admins can read the directory, create regular accounts, and manage regular users. Only the super user can create or manage other admins, change usernames or admin flags, and list active sessions through the dedicated active-users endpoint. The backend prevents self-management and protects the super user profile. The backend records the client IP on successful login. New users have no IP until then.

**Field rules** (the frontend checks the same rules before sending):
- **Name, username, phone and password** are all required to create an account.
- **Username:** 1 to 64 characters, no spaces anywhere and no capital letters. Unique.
- **Phone:** a JSON number of 7 to 15 digits, international, no leading zero.
- **Password:** 8 to 256 characters.
- **Updating a profile:** name, username and phone cannot be cleared; an older account with no phone must add one when it is next saved. The password stays optional (blank keeps the current one).

**Own password at first sign-in.** An admin who creates an account, or sets a new password for one through `PATCH /api/admin/users/:id`, knows that password. Such accounts get `MUST_CHANGE_PASSWORD=1` (`mustChangePassword:true` in profiles and in the login, refresh and `/api/auth/me` responses). Until the user changes it, every protected route answers 403 `{error:"Choose a new password before continuing.",reason:"password_change_required"}`, except `POST /api/auth/password`, `GET /api/auth/me` and `POST /api/auth/activity`; login, refresh and logout work as usual. The team-chat and WAHA dashboard WebSockets refuse the upgrade too. A successful change clears the flag. The bootstrap super user and accounts imported from workbooks start with 0.

Any signed-in user can change their own password with `POST /api/auth/password` and `{currentPassword,newPassword}`. Success returns 204, ends that session everywhere and clears the cookies, so the browser signs in again with the new password. A wrong current password returns 403, invalid input 400, and more than 10 attempts in 15 minutes 429 with `Retry-After`.

Migration decrypts the legacy scrypt verifiers with the workbook’s private sidecar key and re-encrypts them for SQLite. Existing passwords and account IDs are preserved. Fresh installations bootstrap the super user with `ADMIN_PASSWORD`. Use the profile API to rename accounts and the ban API to revoke sessions.

## WhatsApp numbers and who can use them

**Connected numbers.** Every WAHA session is one of the business's WhatsApp numbers. `src/numbers.js` reads them from WAHA (`/api/sessions?all=true`) as `{name,status,me}`. `src/session-phones.js` caches which phone each session is paired to, briefly and shared by all requests, and drops the cached answer when WAHA reports a session status change.
- `GET /api/admin/whatsapp-numbers` (admin roles) lists every session with `defaultSession`.
- **Add Number tab:** `/api/admin/waha-ui/` proxies WAHA's own dashboard (admin roles only) so admins can pair a new number by QR code or pairing code without the WAHA key reaching the browser. Its API calls go through `/api/admin/waha-worker` and are authorized by the Whatix login. Only the calls pairing needs are let through, plus **deleting a number** (`DELETE …/api/sessions/:name`): the main number (`WAHA_SESSION`) is refused with 403, and a deleted number is dropped from the inboxes the backend restarts. WAHA answers a delete with 200 and an empty body; the gateway passes that on unchanged (it used to try to parse it and report a misleading 502 "Could not reach WAHA" after WAHA had already deleted the session). Anything else gets 403 "This dashboard is for connecting numbers."
- `GET /api/my-campaigns` (any signed-in user): admins get every number with its phone; a regular user gets only the numbers granted to them, as `{name,status,phone}`, plus `defaultSession`.

**One API per number.** `/api/inboxes/:name/api/…` serves the same chat API as the main number, for session `:name`. The main number is also reachable without the prefix. A session that is not `WORKING` returns 409. Each inbox has its own sent-message records, waiting notifications, send limits and SSE stream. Holding and AI replies only ever run on the main number.

**Access for regular users (default deny).** `src/campaign-access.js` gates every inbox request from a regular user:
- The user must hold a **grant** for that session *and* its current phone, `campaign_grants (session, campaign_phone, user_id)`. Otherwise every request returns 403 "This campaign is not assigned to you". If the session is re-paired to another phone, old grants stop working rather than moving to the new number.
- Inside a granted number they see only their **contacts**: the customers in `campaign_contacts` for that grant, plus requirements assigned to them that were received by that number. The chat list, message pages, contact names and photos, sends, reactions, deletions, broadcasts and label membership are all checked against those chats; anything else returns 403. Media links in messages carry an HMAC `proof` tied to the user and chat, so a file URL cannot be reused for another chat.
- **Labels:** a grant sees every business label on the number unless an admin limited it (`labels_limited=1`) to the labels in `campaign_grant_labels`. For a label, a user is told only how many chats carry it in total, never who.
- Admin roles are not gated and see everything.

**Assigning numbers (Assign WA Num tab).** Inside an inbox router, admin roles use:

| Endpoint | Contract |
| --- | --- |
| `GET …/api/campaign-grants` | `{phone, grants}` for this number. |
| `PUT …/api/campaign-grants/:userId` | Body `{labels:null}` for every label, or `{labels:[labelId,…]}` (up to 200) to limit them. Returns 204. 422 if a label is gone. |
| `DELETE …/api/campaign-grants/:userId` | Removes the grant and, through foreign keys, its labels and contacts. Returns 204. |

Writes must send header `X-Campaign-Phone` with the phone the admin was looking at; if the session was re-paired meanwhile the request gets 409 "Campaign number changed. Refresh before saving." A disconnected number also returns 409.

**Assigning customers (Assign Contacts tab).** `…/api/campaign-contacts` lists a number's customer assignments (paged, with `?username=` and `?q=`); POST, PATCH and DELETE `…/api/campaign-contacts/:id` change them, with the same `X-Campaign-Phone` rule. The user must already hold that number (422 otherwise). For a regular user, GET returns their own customers.

**Moving a customer from the chat list.** `PUT …/api/campaign-contacts/reassign` (admin roles, same `X-Campaign-Phone` rule) with `{phoneNumber, username}` makes that user the customer's **only** assignee on this number, in one transaction: the chosen user keeps their existing assignment if they had one (same ID and date), and every other user on this number loses it. Returns `{id, phoneNumber, username, assignedAt, removedFrom:[usernames]}`. 400 for a bad phone or missing user, 422 if the user doesn't hold this number. Regular users get 403. Assignments on other numbers are untouched.

**Live updates in the browser.** When an inbox refuses a regular user (403 from `/api/inbox-availability`), the frontend re-reads `/api/my-campaigns` at once, so removing a number moves that user off it within seconds. It also re-reads every 15 seconds while visible.

**Older per-user numbers.** `src/assigned-numbers.js` still serves the original `assigned_numbers` table (`ID, phone_number, user_name`, unique per user, renamed and deleted with the account) through `/api/assigned-numbers` and `/api/admin/assigned-numbers`. The first time a user is granted the main number, their rows there move into that grant's contacts and are deleted from `assigned_numbers`. New assignments go through campaign contacts.

**Removing access directly in the database** (for example during support) bypasses the cached grants. Restart the backend afterwards, or the user can keep access until the cache is refreshed by a write through the app.

## Request and data flow

### Brand Matrix offline intake

> **Status: switched off on purpose.** `AWAY_REPLIES_ENABLED` and `BUSY_REPLIES_ENABLED` are not set, so neither the AI intake nor the holding replies run. The owner wants it that way; do not re-enable them. The description below is kept for when they are turned back on. Both only ever listen to the **main number** (`WAHA_SESSION`); other connected numbers get no automatic replies. Requirements from other numbers are entered by hand on the Whatix AI tab.

The responder in `src/away-replies.js` opens its own WAHA WebSocket for direct incoming messages. It works with every browser closed while the backend, WAHA and Ollama are running. Automatic replies are decided per chat, by who can see it (`src/coverage.js`):
- **Covered:** at least one signed-in staff member can see the chat. That means any admin or the super user, or a regular user who has the client on the main number: as a campaign contact, an older assigned number, or an assigned requirement received by the main number. A covered chat gets holding replies instead of AI intake.
- **Uncovered:** nobody signed in can see the chat. It gets the AI intake responder, even while regular users are signed in for their own numbers. For example, with only alice signed in, her assigned clients get holding replies and every other client gets the AI.

The idle warning counts as signed in. Linked IDs are matched to phone numbers through WAHA. Coverage is re-evaluated when anyone signs in (sign-in waits for it) or out, when an admin saves an assigned number or a requirement's assignees, and at least every 30 seconds. A chat that loses its last viewer starts a fresh offline period, so its AI intake begins anew. Staff signing in or out who cannot see a chat leave its AI conversation untouched. The worker checks the chat's coverage again before sending and drops a draft if someone who can see the chat signed in meanwhile.

Messages from the same sender run in arrival order. The listener reconnects after a disconnect. It skips outgoing messages, groups, unsupported events and messages older than five minutes. A unique event hash in the SQLite `away_replies` table prevents duplicate processing across restarts. The responder does not backfill missed messages or automatically retry an uncertain WhatsApp send.

#### Conversation behavior

Qwen (`qwen3:4b`) reads customer messages in their original language, classifies them and drafts short professional English replies for Brand Matrix. The steps that must be exact are fixed text written by the code, not model output: the name question, the requirement question, the save and update confirmations with their preview, name-change prompts and "What?" clarifications. The model is never asked to address the customer by name. Unfinished intake and pending confirmations live in memory for the uninterrupted offline period. Every outbound reply ends with the WhatsApp bold footer `*this message is Auto Generated*`.

| Customer turn | Expected behavior |
| --- | --- |
| Greeting or salaam | Welcome the customer to Brand Matrix and ask how the team can help. Recognized salaam variants get “Wa Alaikum as-Salaam!”, with any salaam the model echoes back removed. A requirement in the same message as the salutation still goes through intake. |
| Conversational opener | Invite the customer to say what they want to ask. A saved project does not by itself turn a new conversation into an edit. |
| Question | Fixed, honest answers, because Qwen invents business facts (it once claimed Brand Matrix "operates 24/7"). "What services do you offer?" gets the fixed services list. A question about a service ("Do you build mobile apps?") gets *"Yes, Brand Matrix can help with that…"* and an invitation to describe the requirement. Anything else (hours, prices, policies) gets *"A representative will get back to you with the details…"*. A pure question is never saved as a requirement. |
| Nonsense | Qwen classifies messages that can't be understood as `nonsense` ("you cannot", "banana sky", "asdf jkl"). They get *"Sorry, I didn't quite understand that. Could you please be a little more specific about how we can help you?"*, and repeated nonsense gets a version with examples. |
| “I have a requirement” / “I have a new requirement” | Starts a new enquiry: ask for the customer's full name → ask for the requirement → save. This applies to returning customers too. A requirement sent before the name gets the name question and is saved when the name arrives. |
| Specific service request | Everything software-related is in scope: websites, apps, ERP, CRM, SaaS, automation, web3, blockchain, smart contracts, NFTs, crypto, AI and machine learning, chatbots, branding, SEO, advertising and marketing campaigns. A direct request for such work is saved even when Qwen labels it off-topic. Jokes, pretend orders and genuinely unrelated tasks get a brief explanation. |
| Saved confirmation | `Thank you, <name>. We have received your requirement and a representative will follow up shortly.` followed by a preview of the saved row: `*Name:*` and `*Requirement:*`. |
| New project from a returning sender | Saved straight away as a separate unassigned row, with no qualifying questions. It counts as a duplicate only when, once generic words such as "system", "development" and "project" are removed, it adds no words beyond a saved project. A duplicate gets one question asking what makes it different. After “I have a new requirement”, details always describe the new project, never an edit. |
| Revision to a saved project | Applies to the most recently saved project. Ask what should change; the customer's next concrete answer is the amendment, even if Qwen labels it off-topic. The bot restates the change and asks for Yes; a premature Yes writes nothing. Confirmation keeps the row's ID and received date, marks every earlier line of `QUERY` `OLD:`, adds the change as `NEW:`, and replies with the preview. |
| Name correction | "My name is not Alex, it's Talha Javed", "The name field … needs to be Talha", or "The name" followed by the name. The bot asks to confirm the new name with Yes, then updates `NAME` on the sender's latest row. A name matching the saved one gets “No change was needed.” |
| Callback-number edit | Ask the customer to confirm the proposed international number. Confirmation changes `PHONE` on the existing requirement. The linked sender identity and the original number used for assigned-chat access remain in place. |
| Withdrawal, acknowledgment or confusion | A decline clears unfinished intake. A bare “OK” / “Oky” / “Okay” gets no reply after a decline or a closing message, or when nothing is pending. “What?” gets fixed wording describing what the bot is waiting for (name, requirement, change or Yes) and never starts an edit. |

**Name check.** A name answer is accepted in two stages:
1. **Code rules:** one to six words of letters in any script, none of them a common non-name word (you, ready, like, name, update and so on), and no keyboard mash. Initials ("M Talha", "S. Ahmed"), short forms ("Md Rahim"), hyphens and apostrophes ("Mary-Kate", "O'Brien") and particles ("bin", "van", "de la") are allowed. For Latin letters, mash means no vowels, three repeated letters, six or more consonants in a row, or keyboard rows such as "asdf" or "qwer".
2. **Qwen judgement:** `nameCheck` decides whether the answer is a genuine personal name. Its prompt lists Pakistani, Indian, American, European, African and East Asian examples, and it accepts real people's names even if famous. It rejects ordinary words (Pizza, Website), brands, fictional and superhero characters (Batman, Spider Man, Mickey Mouse), placeholders (Test), insults, refusals and sentences.

Input typed all in lower case or all in capitals is capitalized ("talha javed" becomes "Talha Javed"), with particles kept in lower case ("mohammed bin salman" becomes "Mohammed bin Salman"). Mixed-case input keeps the customer's own spelling. Qwen returns one of three verdicts:
- `name`: the name is accepted directly.
- `not_name`: the bot replies *"Sorry, that doesn't look like a name…"*, and a second rejection gets a firmer request with an example.
- `unsure`: for nicknames or titles ("King Khan"), apparent misspellings ("Tlha Javd") and words also used as names ("Sunny", "Sky", "Prince"). The bot asks *"Just to confirm, is \*Sunny\* your correct name? Please reply Yes to confirm, or type your name again."*

Answers to that question:
- **Positive** (yes, yeah, correct, sure, ok, haan, ji, jee, bilkul, theek hai, sahi hai, جی ہاں and similar): the name is saved.
- **Negative** (no, nope, wrong, nahi, galat, نہیں and similar): the bot asks *"No problem. Could you kindly re-write your full name so we can record it correctly?"* "No" here is never treated as withdrawing from the conversation.
- **Anything else** is treated as a new name attempt. A second ambiguous answer is confirmed again in different words, and "What?" repeats the question. Name corrections go through the same check. If Qwen is unavailable, the code rules alone decide. Saved names that fail the code rules, such as "You" or "Do you like pizza" left by earlier versions, are treated as unknown.

**Requirement check.** Before any requirement is saved, `assessRequirement` asks Qwen whether the answer is a genuine lawful requirement, an information question, unlawful work, or not a requirement. Any naming of an in-scope service counts as a requirement, even a short one like "a website".
- **Question** ("How much does a website cost?"): detected by the code as well, never saved, and answered with fixed wording. That wording says a representative will confirm pricing and timelines, so Qwen cannot make up a price; it once offered "starting from $1,500". It then asks for the requirement again.
- **Unlawful** (for example a site to sell stolen phones): refused with a fixed message.
- **Off-topic** ("Fix my car"): the fixed "outside what Brand Matrix offers" reply.
- **Gibberish or vague** ("idk", "I need something", "asdf qwer"): *"That doesn't look like a project requirement yet…"* with examples, then a more specific prompt on the second try.

If the check fails to run, the earlier extraction and qualification decide.

**Keeping Qwen on track.** Task-driven turns (change requests, clarifications, callback confirmations, duplicate questions) give Qwen the recent conversation as data, not as chat messages; with chat messages, qwen3:4b tends to repeat the customer's last message. Saved summaries use only details the customer stated, and bracketed notes the model adds are removed unless the customer wrote them. If Qwen's amendment summary shares no meaningful word with the customer's message, the customer's own wording is saved. When qwen3:4b splits a copied word or number with a colon ("500" → "5:00"), the code joins it back whenever the original came from the customer or saved facts. Closing messages drop any sentence asking for another Yes. Confirmation drafts must ask for Yes and must not claim an unconfirmed change was made.

The responder retries malformed structured model output once. Reply validation rejects placeholders, echoed instructions, copied customer text, repeated assistant replies and unwanted reintroductions. The customer is never left without a reply because of a bad draft. If a model reply fails for any reason (rejected twice, timed out or an Ollama error), the bot sends fixed wording and logs `Away reply draft failed, sent fixed wording`:
- a goodbye after a decline
- a thank-you with the name after a closing
- the polite "didn't understand" message otherwise

Update requests, change confirmations, name questions and duplicate-project questions also have their own fixed fallbacks. A failure in the classification step (Ollama unreachable), or an unconfirmed WAHA send, can still leave a message unanswered. Warnings identify the failing stage and, where available, the HTTP status or system error code. Diagnostic messages omit customer text and credentials.

**Testing caveat.** Conversation state is in memory. A backend restart, including every `node --watch` reload in `npm run dev`, and any staff sign-in or sign-out clear it. The bot then reintroduces itself and loses half-finished intake. Avoid editing code or signing into the dashboard mid-conversation while testing.

#### Requirements and chat ownership

`src/offline-requirements.js` uses the `"offline requirements"` table with columns `ID, NAME, PHONE, QUERY, DATE_RECIEVED, assigned_user, RECEIVED_SESSION, RECEIVED_BY`. IDs and phones are numeric. `PHONE` is the client's number (shown as **Client Phone**). `RECEIVED_SESSION` and `RECEIVED_BY` record which of our numbers received it (shown as **Received by**); rows without them, including everything the AI intake saves, belong to the main number. The date is stored as `YYYY-MM-DD` in Asia/Karachi. The direct sender ID or a WAHA linked-ID lookup supplies the phone. If the lookup cannot resolve it, the assistant asks for an international callback number.

The `intake_context` table links each row to hashed session-scoped sender identifiers, a version and up to six recent customer messages at save time, each limited to 1,000 characters. A confirmed callback edit also retains the original chat number in `ORIGINAL_CHAT_PHONE`. A confirmed name correction rewrites `NAME` on the sender's latest row through the same versioned update. Ownership lookup uses the WhatsApp sender and verified number. A typed callback number cannot authorize an edit. For legacy unlinked rows, a verified phone match can associate the newest eligible ID with the sender. Writes are serialized and atomic. Version checks protect against stale updates.

#### Admin grid (Whatix AI tab) and assignments

Both admin roles can manage the grid. Regular accounts receive 403 and signed-out requests receive 401. Every row is returned with `receivedBy:{session,phone,main}`.

| Endpoint | Contract |
| --- | --- |
| `GET /api/admin/offline-requirements` | Optional inclusive `from` and `to` dates use `YYYY-MM-DD`. Defaults are the first and last day of the current month in Asia/Karachi. Paged with `page`, `pageSize` and `q` (see [Paged grids](#paged-grids)); `q` matches name, client phone, query and our receiving number. Returns `{from,to,requirements:[{id,name,phone,query,dateReceived,assignedUsers,receivedBy}],…page fields}`, newest date and then highest ID first. Invalid or reversed ranges return 400. Database failures return 503. |
| `POST /api/admin/offline-requirements` | Add a requirement by hand. Body `{name, phone, query, dateReceived, receivedSession}`, all required: name up to 128 characters, client phone 7 to 15 digits as a JSON number, query up to 4,000 characters, a date that is not in the future, and the session of one of our **connected** numbers (its phone is stored as `RECEIVED_BY`). Returns 201 with `{requirement}`. |
| `PATCH /api/admin/offline-requirements/:id` | Same body and rules. Keeping a receiving number that has since disconnected is allowed; choosing a different disconnected one is not. Returns `{requirement}`, 404 if gone. |
| `DELETE /api/admin/offline-requirements/:id` | Deletes the row and its intake context. Returns 204, 404 if gone. |
| `GET /api/admin/offline-requirements/assignees?requirement=ID` | Fetch when editing a row's users. Returns `{session,phone,users:[{id,name,username}]}`: only regular users who hold the number that **received** that requirement, because nobody else could open the client's chat. Without `requirement`, the main number is used. 503 if that number's phone cannot be confirmed. |
| `PATCH /api/admin/offline-requirements/:id/assignees` | Send the complete `userIds` selection and optional `expectedUserIds` from the row before editing. An empty selection clears the assignment. Success returns `{requirement}` with updated `assignedUsers`. Invalid or duplicate IDs return 400, a missing requirement 404, a stale selection 409, and a user without that number 422. |

The database stores `assigned_user` as a JSON array of stable numeric account IDs. An empty array represents an unassigned requirement. The importer also accepts older five-column workbooks. Each grid row resolves eligible IDs to `{id,name,username}` objects. A requirement assigned to a user makes that client one of their contacts **on the number that received it**, alongside their campaign contacts. Removing one grant preserves access through any other applicable grant.

### Paged grids

The admin grids ask for one page at a time with `?page=N&pageSize=M` (default 10, at most 100) and an optional `?q=` search of up to 100 characters (`src/paging.js`). Paged responses add `{page, pageSize, total, pages}`. A page past the end comes back empty with the real total, so the grid can step back. Without `page` and `pageSize`, the full list is returned, which pickers and older callers rely on. Invalid values return 400. Paged endpoints:
- `GET /api/admin/users`: also `?role=user` (regular users only) and `?campaign=<session>&campaignPhone=<digits>` (only holders of that number). Every response includes `summary:{total,online}`.
- `GET …/api/campaign-contacts`: also `?username=`.
- `GET /api/admin/offline-requirements`, within its date range.

### Holding replies while staff are busy

`src/busy-replies.js` covers the time when someone is signed in but has not reached a chat. The offline AI responder still handles the time when nobody is signed in. Both share the same WAHA message WebSocket.

- **When it replies:** a direct message from a customer arrives while the chat is covered, meaning a signed-in admin, the super user, or a regular user it is assigned to can see it. If nobody opens or answers that chat within `BUSY_REPLY_DELAY_SECONDS` (default 1 minute), the customer gets one fixed holding reply ending with the auto-generated footer. The three rotating wordings are along the lines of *"Our representatives are currently assisting other customers and will be with you shortly. We appreciate your patience."* A salaam gets "Wa Alaikum as-Salaam!" first.
- **Follow-up:** if the client writes again while still unattended, they get one warm, apologetic follow-up, for example *"We sincerely apologise for the wait, and thank you so much for your patience…"*. Three wordings rotate in `followUpReplies`. It is sent no sooner than `BUSY_FOLLOWUP_GAP_SECONDS` after the first holding reply, and at least `BUSY_REPLY_DELAY_SECONDS` after the new message. After that, at most one more follow-up goes out per `BUSY_REPLY_COOLDOWN_SECONDS` while the chat stays unattended. Attending the chat resets the cycle, so the next wait starts with the normal holding reply. Each follow-up also moves the client's bell notification to the top.
- **When it stays quiet:**
  - a chat a staff member opened or answered in the last `BUSY_ENGAGED_SECONDS` (the customer already being helped)
  - further messages after the follow-up, until the cooldown has passed
  - groups and the business's own messages
  - the case where everyone who can see the chat signs out before the delay ends (the offline responder then answers new messages)
  - another holding reply within `BUSY_REPLY_COOLDOWN_SECONDS`, unless the chat was attended in between
- **Attended means:**
  - a staff send or read receipt through the `/api/send*` proxy
  - the browser reporting an opened chat with `POST /api/chats/attended {"chatId":"…"}`. The frontend's `markAttended` calls this when a chat with unread messages is viewed in a focused window. The route requires sign-in, returns 204, and returns 400 for anything other than a direct chat ID.

  Linked IDs (`@lid`) are matched to phone numbers through the WAHA lookup.
- **Waiting notifications:** each holding reply that WAHA accepts creates one notification per chat in `src/waiting-alerts.js`, with fields `{id, chatId, phoneNumber, openKey, since}`. The stream `GET /api/incoming-text` delivers them:
  - on connect, a `client.waiting.snapshot` event with the current list
  - live `client.waiting` events as new ones arrive
  - `client.attended` events with `{id}` once a staff member opens or answers that chat, which removes it for everyone

  Each stream only gets notifications for chats its user can see: admins and the super user see all, regular users their assigned numbers. A failed holding reply creates no notification. Notifications are in memory, so a restart clears them.
- **Unread counts:** holding replies are sent directly to WAHA, not through the proxy. They never count as attending the chat, never send a read receipt and never change the frontend's unread badge. That badge counts incoming messages until a staff member opens the chat.
- **Limitations:**
  - State is in memory, so a restart forgets pending holding replies.
  - A reply typed on the WhatsApp phone app, rather than in this app, is not seen as attending the chat.

`tests/coverage.test.js` covers the role rules (admin sees all, regular user sees assigned numbers), fresh offline periods, linked IDs and overlapping refreshes. The session integration test checks that a regular user with the number assigned pauses the AI. `tests/busy-replies.test.js` also covers notifications being created only after a sent holding reply and cleared on attendance, and `tests/coverage.test.js` covers notification visibility per role. `tests/notifications.test.js` runs the real server against a mock WAHA. It checks that the super user receives every waiting client live, a regular user only their assigned client, and a regular user with no assignments nothing. It also checks that attending clears the notification for everyone and that a late connection gets a filtered snapshot. `tests/busy-replies.test.js` covers the delay, single reply per stretch, the engaged ClientA versus waiting ClientB case, cancellation on open, sign-out, linked-ID matching and ignored groups.

### Background broadcasts

Limits: up to 5,000 recipients per broadcast and 3 unfinished broadcasts per user at a time (a fourth returns 429). For a regular user, every recipient must be one of their contacts on that number.

Use the existing direct-send flow for up to 10 distinct recipients. For larger audiences, authenticate and send one POST to `/api/broadcasts` with a client-generated UUID `id`, an ordered `recipients` array, a `kind` (text, document, image, video, or voice), and `text` (message or caption). Media includes one `file` with filename, mimetype, and either Base64 data or an HTTP(S) URL. Video and voice accept boolean `convert`. Use the existing upload size check. For URL media, the backend downloads the link once when the job is accepted (public addresses only, see [Security hardening](#security-hardening)) and the job keeps the downloaded data, so the link need not stay up. Pass the reviewed membership snapshot. Numeric recipients and equivalent PN chat IDs are normalized and deduplicated. LIDs remain separate identities; resolve known aliases in the existing audience picker before counting.

POST returns 202 with a progress snapshot. Retry an uncertain submission with the identical UUID and payload. A conflicting reuse returns 409; invalid requests and audiences of 10 or fewer return 400. Poll authenticated `GET /api/broadcasts/:id` from the owning account. It returns 404 for unknown or other owners' jobs. Both responses contain id, status (queued, sending, waiting, completed, completed_with_errors), total, processed, sent, unsuccessful, nextBatchAt (Unix milliseconds or zero), and results in submission order. Each result has canonical chat ID `number`, boolean `ok`, optional receipt `id` and numeric `ack`, or an error. Sent counts WAHA HTTP acceptance. Delivery/read state comes from the usual acknowledgements.

The worker processes jobs FIFO, one recipient at a time in randomly sized chunks of 10–15, with a potentially smaller final chunk. A fresh random delay of 10–20 minutes begins after each nonfinal chunk. Work continues after browser close and logout. The worker checks for a banned/deleted sender before processing each chunk. Keep the backend and WAHA running and persist the Whatix SQLite database. A restart resumes from the saved position and deadline. An interrupted, unconfirmed send is recorded as unsuccessful without resending. Payloads are deleted after completion. Job IDs, recipient lists and receipt results remain on disk for history and duplicate prevention. Run a single backend process against this database.

### Incoming call notifications

Only admins and the super user receive incoming call notifications and can decline calls for the configured WAHA session. While a browser has the authenticated `GET /api/incoming-text` stream open, the backend listens for WAHA call events. The named SSE event `call.received` contains `{id,phoneNumber,isVideo,isGroup}`. The phone number is an international string with a leading plus or null. For a linked ID, the banner can appear immediately and a second event with the same call ID supplies the number if WAHA resolves it. Upsert by ID. Reconnecting streams receive calls still tracked in memory.

Send `POST /api/calls/decline` with JSON `{"id":"<call id>"}` and the signed-in user's cookies. The backend gets the original caller and session from server state. A 202 means WAHA accepted the decline signal. Show “Decline requested” and allow retry while the call remains visible. A 204 means the tracked call ended while the request was in flight. A 409 means the call is unavailable, a 400 indicates invalid input, and a 502 means the decline could not be confirmed. Concurrent declines share an in-flight request. The SSE event `call.ended` contains `{id}` and dismisses the banner for every connected user after a WAHA accepted/rejected event or a 60-second local timeout. WEBJS emits a synthetic rejection marked `_data.api=true` when it sends the signal. The backend ignores this local acknowledgement. The timeout only clears the notification. Call state is ephemeral, and calls missed while every browser was disconnected have no replay.

The mock WAHA integration test exercises call subscriptions, session filtering, caller numbers, linked-ID resolution, acceptance elsewhere, decline authentication, upstream failure, retry, and final dismissal.

### Voice notes

Voice notes use authenticated POST /api/sendVoice with session, chatId, a Base64 file object and the WAHA convert flag. Live direct-chat audio and push-to-talk messages emit kind=voice. History uses the same media classification in the frontend. Recording creates a local draft for preview before explicit send. Ogg/Opus is preferred; other supported MediaRecorder formats request WAHA conversion.

### Sent-message deletion

For direct-chat sends with a usable WAHA receipt, the backend records the app account's numeric ID and destination in SQLite, under the `sent` namespace of `app_records`. These session-scoped records contain no message bodies. Include these records in database backups. Earlier sends and messages sent outside the app have no verified app owner.

Authenticated clients call `POST /api/messages/deletion-state` with `{"ids":[...]}` (up to 100 WAHA receipt IDs). The response contains `messages` with `id`, `mine`, `hidden`, and `revocationRequested`. Apply this state when merging WAHA history and local IndexedDB rows. Raw WAHA history retains its existing pagination and shape.

`DELETE /api/messages/:id` accepts JSON with `scope` set to `me` or `everyone`. The server checks the authenticated account against the original send receipt. Personal hiding persists only for the sender. Global revocation uses the recorded chat and the server-configured session. A 200 response includes the updated flags. WAHA acceptance does not confirm removal from every device. Unknown or unowned IDs return 404, a declined revocation returns 409, and service or storage failures return 502/503.

### WhatsApp Business labels

In the chat UI these are called **campaigns** ("Manage campaigns", "Delete campaign…"), and the error messages these routes return say "campaign" too. The API, WAHA and the WhatsApp Business app still call them labels.

WAHA stores the labels themselves. `src/business-labels.js` creates labels and adds contacts to them, `src/label-import.js` previews Excel imports, and `src/label-deletion.js` deletes labels and keeps the change history that browsers apply to their saved conversations.

**Excel import preview.** `POST /api/business-labels/import-preview?project=<type>` takes the raw bytes of a `.xlsx` workbook (`Content-Type: application/octet-stream`, up to 10 MB). It writes nothing; the browser then adds the returned numbers to a label one at a time.
- **Project types:** `project` must be one of `SHP(Single Unit)`, `Water Bottles`, `HDHP(Full Share)`, `Gaza Water Tank Units` or `Gaza Food`.
- **Header row:** every worksheet is scanned for a row with both a `Contact Info` and a `Project Type` header. Matching is case-insensitive and ignores spacing.
- **Rows and numbers:** rows whose project type matches are read. A contact cell can hold several numbers separated by commas, semicolons, slashes, pipes or line breaks. Spaces, brackets, dashes and a leading `+` are removed, and only 7- to 15-digit international numbers are kept, without duplicates.
- **Response:** `{numbers, matchingRows, skipped}`, where `skipped` counts tokens that were not valid numbers.
- **Errors:** an empty upload returns 400. An unknown project type, an unreadable file or a missing header row returns 422.

**Deleting a label.** Admin roles only. `GET /api/business-labels/:id/deletion-preview` returns `{chats:[chatId,…]}`, the label's current member chats. `DELETE /api/business-labels/:id` takes `{scope}`:

| Scope | Effect |
| --- | --- |
| `label` | Deletes only the label. Chats and messages stay. |
| `history` | Deletes the label and records the change, so every Whatix browser clears that label's saved conversation. The WhatsApp chats stay. |
| `chats` | Deletes every member chat from the connected WhatsApp account, including chats that also carry other labels, then the label. This affects everyone using that account. The request must include `expectedChats`, the list from the deletion preview. |

How a deletion is guarded and retried:
- **Changed membership:** if the members no longer match `expectedChats`, or new chats join while deleting, the request returns 409 asking for a fresh review.
- **One at a time:** a deletion already running for the label returns 409. So do contact additions to it (`POST /:id/contacts`) during a deletion, and a deletion while contacts are being added.
- **Partial failure:** progress is recorded per chat. A failure returns 502 with the number of chats already deleted, and retrying the same scope resumes. A label that is already gone counts as done when its recorded scope matches.
- **Success:** returns `{deleted}`, the number of chats removed.

**History changes.** `GET /api/business-labels/history-changes` returns:
- `labels`: deleted labels with their scope and time
- `chats`: deleted chats with their time. For regular users, only chats they can see.
- `personalChats`: chats the caller removed from their own list. Always `{}` for regular users.

Browsers use this to hide or clear their saved history. All of it is stored in SQLite `app_records`, scoped to the WAHA session.

`tests/label-import.test.js` covers project filtering across worksheets and confirms the preview makes no label writes. `tests/label-deletion.test.js` covers the three scopes, membership changes and retrying after a partial deletion.

### Team chat between app users

`src/team-chat.js` runs a WebSocket at `/api/team-chat` on the same HTTP server, so signed-in app users can message each other in real time. This is separate from WhatsApp: nothing goes through WAHA.

**No database.** Messages are never written to SQLite or any file.
- **Online recipients** (at least one open chat socket) get a message immediately.
- **Offline recipients:** the message waits in this backend process's memory, up to 500 per recipient, oldest dropped first, for at most 7 days. When they next connect, it is sent to them after `hello` with `waited:true` and then dropped, so it is handed over only once.
- **The sender, if connected,** then gets a `delivered` frame.
- **What loses waiting messages:** a backend restart. Deleting the account discards its queue.

**Who can message whom.** The server checks every recipient against the account directory, online or not:

| Sender | Can message |
| --- | --- |
| Super user, admin | Any other account. One message to several recipients at once is allowed, but only to regular users. |
| Regular user | Admins, one recipient per message. They also see and can answer the super user, but only in a conversation the super user started with them. |

**Super user conversations.** Regular users' contact lists never include the super user.
- When the super user sends a message to a regular user, directly or in a group, that user is added to the in-memory `opened` set. Their browser gets a fresh `contacts` list that includes the super user, before the message itself.
- When the super user closes the chat window, the client sends `{type:"close", with:userId}`. The server:
  - removes the user from `opened`
  - discards the super user's messages still waiting for them
  - sends them `{type:"conversation-ended", id:superUserId}` and a contacts list without the super user, so their client removes the thread
  - sends `{type:"conversation-ended", id:userId}` to the super user's other tabs so they close the window
- After that, the regular user's sends to the super user get "You can only message admins."
- On reconnect, the super user's `hello` includes `conversations:[userIds]` still open, so they come back as minimised windows and can be closed.
- A backend restart ends all of these conversations.

Banned accounts are left out of the directory. The role comes from the live session (`roleOf`), so a role change, which revokes the session, takes effect on the next connection.

**Connection and authentication.**
- The upgrade request must carry a valid `wa_access` cookie for the current session. Otherwise it gets HTTP 401. An `Origin` header other than `FRONTEND_ORIGIN` gets 403. A missing Origin is allowed, as for HTTP requests. Any other upgrade path gets 404.
- After the upgrade, the socket is tied to the sign-in session through `session.streams`, not to the 15-minute access token. Logout, idle expiry, ban, deletion, rename, password reset or an admin flag change all close it. Close code 4001 means `admin_revoked`, and 4000 means any other session end.
- One account can have several sockets (browser tabs). Messages go to every tab, and a message sent from one tab also appears in the sender's other tabs.
- A ping every 30 seconds drops connections that stop answering. Limits: 64 KB frames, 4,000 characters per message, 500 recipients, and 30 sends per 10 seconds per socket.

**Daily reset at 21:00 Pakistan time.** Every day at 16:00 UTC (PKT is UTC+5 with no daylight saving), a timer in `src/team-chat.js` (`nextReset`) wipes all chat state so the network starts clean:
- messages still waiting for offline users
- open super-user conversations
- read-receipt records

Every connected browser gets `{type:"reset", at}` and a fresh contacts list (so the super user disappears from regular users' lists). The browser clears its conversations, windows and chat notifications. `hello` carries `resetAt`, the time of the last reset, so a tab that was disconnected at 21:00 clears its old conversations when it reconnects. The timer reschedules itself after each run.

`tests/team-chat-reset.test.js` covers:
- the 21:00 PKT timing, including exactly 21:00, after midnight and the year boundary
- a reset dropping waiting messages and conversations
- regular users losing the super user again after a reset

**Message states** shown to the sender:
- **sent:** one tick. The server accepted the message and it is waiting for an offline recipient.
- **delivered:** two grey ticks. It reached the recipient's browser, either at once (`sent.delivered`) or later (`delivered` frame).
- **read:** two blue ticks. The recipient opened it (`read` frame).

For read receipts, the server keeps an in-memory map of message ID to sender and readers still pending, capped at 20,000 entries (oldest dropped). It never keeps the text. So a client can only mark as read messages that were really sent to it, and only once. Receipts are not queued: a receipt for a sender who is offline is dropped, since their conversation view is gone anyway.

**Protocol** (JSON text frames):

| Direction | Frame |
| --- | --- |
| server → client | `{type:"hello", me:{id,username,name,role}, contacts:[{id,username,name,role,online}]}` right after connecting. `contacts` is only the accounts this user may message. |
| server → client | `{type:"presence", id, online}` when a contact opens their first socket or closes their last. |
| client → server | `{type:"roster"}` asks for a fresh list and gets `{type:"contacts", contacts}`. |
| client → server | `{type:"send", clientId, to:[accountId,…], text}` |
| server → sender | `{type:"sent", clientId, id, at, to, delivered:[ids], queued:[ids]}`. `queued` lists offline recipients whose copy is waiting. |
| server → sender | `{type:"delivered", id, to}` when a waiting message reaches recipient `to` on sign-in. |
| client → server | `{type:"read", ids:[messageId,…]}` (up to 500) once the reader has the messages open on screen. |
| server → sender | `{type:"read", ids, by, at}` read receipt. Sent once per message and reader, and only for messages actually sent to that reader. |
| client → server | `{type:"close", with:userId}` from the super user, ending a conversation with a regular user. |
| server → client | `{type:"conversation-ended", id}`. For a regular user, `id` is the super user and the conversation disappears. For the super user's other tabs, `id` is the regular user whose window closes. |
| server → recipients | `{type:"message", id, from:{id,username,name,role}, to, text, at, group, waited?}`. `group` is true when sent to several people. `waited` is true for a message held while they were offline. `at` is the original send time. |
| server → client | `{type:"error", clientId?, error}` for a refused send (permission, empty or too long text, rate limit) or a contacts failure. A refused send delivers to nobody. |

**Limitations.**
- The online map and the waiting messages live in this backend process, so a restart loses waiting messages and the chat assumes the single-process deployment the sessions already require.
- A reverse proxy must forward WebSocket upgrades (`Upgrade`/`Connection` headers) for `/api/team-chat`.
- A display-name change through `PATCH /api/admin/users/:id` applies to that user's later messages straight away, but other users' contact lists update only on their next `roster` request or reconnect.

`tests/team-chat.test.js` runs the real server and real WebSocket clients:
- refusal of unauthenticated and cross-origin upgrades
- role-filtered contact lists and presence
- a group send to two online users and one offline user, which is queued
- queued messages handed over when the offline user signs in (once, not again to a second tab), with `delivered` sent to the sender
- regular users replying to an admin
- regular users not seeing or messaging the super user until the super user writes, then seeing them, and losing them again (`conversation-ended`) when the super user closes the chat
- read receipts sent once, and ignored for unknown message IDs
- the super user's `hello` listing conversations still open
- refusal of regular-to-regular messages (including to offline users), regular multi-sends and group sends that include an admin
- logout closing the socket with 4000

### API reference

Signed-in users can create shared WhatsApp Business labels through `POST /api/business-labels` with `{name,color}` (integer color 0–19, default 0). A 201 response contains the WAHA label with a string ID. Use `POST /api/business-labels/:id/contacts` with `{contactId}` once per selected direct chat or international phone number. A 200 response reports `added` or `already_added`. The backend reads and merges existing labels before writing, resolves phone numbers through WAHA check-exists, and serializes additions under the returned chat ID (which can be an @lid). An unregistered phone returns 422. After a write, it rechecks chat labels with short delays and falls back to the label member list before reporting an unconfirmed assignment. WAHA stores the labels. Refresh the existing label and membership endpoints after changes. External edits from another WhatsApp client during the read/write interval can still race.

| Endpoint | Contract |
| --- | --- |
| `GET /api/health` | Public liveness check returning `{"ok":true}`. WAHA readiness is untested by this route. |
| `GET /api/contacts/profile-picture?contactId=...` | Authenticated contact photo lookup using the configured WAHA session. Accepts international digits (optional leading +) or direct chat IDs ending in @c.us, @s.whatsapp.net or @lid. Returns JSON with a temporary HTTPS `profilePictureURL` or null. Invalid IDs return 400 and upstream errors return 502. |
| `POST /api/auth/login` | Accepts a JSON object with a `credentials` string containing Base64-encoded JSON with string `username` and `password`. Each IP has separate limits for the configured super user and for all other login attempts, ten failed attempts per 15 minutes each, plus 30 failed attempts per 15 minutes per account from any address. Success sets access and refresh cookies. **Signing in takes over:** correct credentials from another browser or device end the account's existing session (its tabs are told `signed_in_elsewhere`) and start a new one. A browser already signed in as a *different* account gets 409 "Log out of the current account before switching users." |
| `POST /api/auth/refresh`, `POST /api/auth/logout` | Refresh checks the signed cookie and its in-memory token ID, then replaces both tokens. The previous refresh token stays valid for 30 seconds, so a retry after a lost response still works. Reusing an older, rotated token ends the session (theft protection). A refresh token whose session was taken over by a sign-in elsewhere gets 401 with `reason:"signed_in_elsewhere"`. Logout from the owning session revokes its access and refresh tokens, closes its live streams, and clears both cookies. |
| `POST /api/auth/password` | Changes the signed-in user's own password; see [Accounts](#accounts). |
| `POST /api/auth/activity` | Requires access credentials. An empty request reports user activity. At or after the warning, only a JSON body of `{"keepSession":true}` renews the session. Ordinary activity then returns 409 with the current deadlines. Expired sessions return 401. |
| `GET /api/auth/me` | Requires access credentials. Returns the configured username and the remaining access-token lifetime (`expiresIn`) in seconds. |
| `GET /api/admin/username-availability?username=...` | Admin access. Returns `{"available":true}` or false for a valid case-sensitive username. Registration and profile updates also check uniqueness when saving. |
| `POST /api/admin/users` | Admin access. Only the super user may grant admin status. Requires `name`, `username`, `password` and numeric `phoneNumber` (see the field rules under [Accounts](#accounts)); optional boolean `isAdmin` and `banLogin`. Returns 201 with a public profile, 400 naming the first missing or invalid field. |
| `GET /api/admin/users` | Admin access. Lists all accounts as `{users:[...],summary}`, including signed-out and banned ones, super user first, then admins. Paged and filterable; see [Paged grids](#paged-grids). Each profile includes id, name, username, banLogin, dateCreated, userIp, phoneNumber, isAdmin, isSuperUser and nullable sessionId. Password data is private. |
| `GET /api/admin/users/:id` | Returns one directory profile by numeric account ID. Both admin roles can fetch profiles. Update and delete follow the target-account restrictions above. |
| `PATCH /api/admin/users/:id` | Send one or more changed fields from name, username, phoneNumber, password, banLogin and isAdmin. Returns the saved profile. Rename, password reset, admin flag changes and enabling a ban revoke the target session. A rename through this endpoint preserves the existing password unless a replacement is supplied. |
| `DELETE /api/admin/users/:id` | Permanently removes the Excel account and revokes its session. Returns 204. Its ID remains retired. The super user profile is read-only. |
| `POST /api/admin/users/:id/ban` | Admin access for permitted target accounts. Send `{banLogin:true}` to persist a ban and revoke a current session, or false to restore login eligibility. Returns 204. The super user is protected. |
| `GET /api/admin/active-users` | Super user only. Returns `{users:[{sessionId,username,startedAt,lastActiveAt}]}` for signed-in admins and regular users, including those in their idle warning period. Timestamps are Unix milliseconds. Polling leaves idle deadlines unchanged. |
| `POST /api/admin/sessions/:id/end` | Admin access for permitted target accounts. Targets the exact session from the list. Returns 204 on success, 404 if gone, 403 for regular users, and 401 without authentication. Invalidates both tokens and sends a `session-ended` SSE event with reason `admin_revoked` before closing each connected stream. Optional JSON body `{"banLogin":true}` also persists a ban. The default false ends only the selected session. |
| `GET /api/assigned-numbers` (older per-user numbers) | Any signed-in account. Returns `{assignments:[{id,phoneNumber,username}]}`. Regular users get their own manual and requirement-derived numbers. Requirement-only rows have a string ID and `source: "offline_requirement"`. Admin roles get manual assignment rows, optionally filtered by `?username=`. |
| `POST /api/admin/assigned-numbers` | Admin access. Body `{phoneNumber,username}` (both required, phone as a JSON number). Returns 201 with the row. 400 for invalid fields, 409 for a duplicate number and user pair, 422 for an unknown user or an admin/super-user assignee. |
| `GET`, `PATCH`, `DELETE /api/admin/assigned-numbers/:id` | Admin access. GET returns one row. PATCH accepts `phoneNumber` and/or `username` and returns the saved row, with the same 400/409/422 rules. DELETE returns 204. Unknown IDs return 404. |
| `POST /api/sendText`, `sendImage`, `sendVideo`, `sendVoice`, `sendSeen`, `sendFile` (all under `/api`, or `/api/inboxes/:name/api` for another number) | Require access credentials and a body `session` matching that inbox. The backend rebuilds the WAHA request from the fields each route allows (`src/send-body.js`) instead of forwarding the browser's JSON, and downloads media links itself. 120 sends per minute per user per number; more get 429. Regular users can send only to their contacts. |
| `GET` or `HEAD /api/{session}/…` | Allows labels, chats for a label, numeric LID lookup, chat overview, and message list/detail for supported direct-chat IDs; admins also group participants and group messages. Query parameters pass through. For regular users the answers are filtered as described under [WhatsApp numbers](#whatsapp-numbers-and-who-can-use-them). |
| `GET /api/my-campaigns`, `GET /api/admin/whatsapp-numbers`, `/api/inboxes/:name/…`, `…/campaign-grants`, `…/campaign-contacts` | See [WhatsApp numbers and who can use them](#whatsapp-numbers-and-who-can-use-them). |
| `GET /api/inbox-availability` | Any signed-in user, per inbox. Returns `{account}`, an opaque HMAC identifying this number, its phone and the caller's access, or `{account:null}` when the number is not paired. The browser polls it every 5 seconds while visible: a changed value means the number was re-paired (local caches are dropped), and 403 means the user lost access. The phone answer behind it is at most 5 s old and shared by all tabs. |
| `GET` or `HEAD /api/files/…` | Proxies authenticated file requests with path filtering and sandbox headers. Selected image, video and audio types display inline with byte-range playback. Other types are served as attachments. |
| `GET /api/incoming-text` | Opens an authenticated Server-Sent Events (SSE) stream. All streams of an inbox share one upstream WAHA WebSocket (`src/upstream-hub.js`): `ready` is sent once it is open, and a dropped socket ends every stream so browsers reconnect and resync. At most 8 streams per user per inbox: a ninth closes the oldest. For regular users, events are filtered to their contacts. Emits `ready`, incoming direct messages with optional attachment metadata, `receipt` events for outgoing acknowledgements, named `call.received` and `call.ended` notifications, and the waiting-client notifications `client.waiting.snapshot`, `client.waiting` and `client.attended`. Sends heartbeats every 20 seconds and requests a three-second client reconnect delay. There is no replay buffer. |
| `PUT /api/reaction` | Body `{messageId, reaction}`, where `messageId` is a direct-chat WAHA message ID and `reaction` is an emoji of up to 32 characters (an empty string removes it). Regular users can react only in chats they can see (403 otherwise). Returns 204, 400 for invalid input and 502 when WAHA declines or cannot be reached. |
| `GET /api/contacts/name?contactId=…` | `contactId` must be a direct chat ID ending in `@c.us` or `@lid`. Returns `{name}`, the contact's saved or push name, or null. Values that only look like a phone number count as no name. Regular users get 403 for chats they cannot see. 400 for an invalid ID, 502 when the lookup fails. |
| `GET /api/session-identity` | Admin roles only. Returns `{session, number, lid}` for the connected WhatsApp account: the WAHA session name, its number as `+digits` (or null) and its linked ID ending in `@lid` (or null, looked up from the number when WAHA does not report it). 502 when WAHA is unavailable. |
| `DELETE /api/chats/:id/from-my-list` | Admin roles only. Hides a direct chat from the caller's own chat list without touching WhatsApp. `:id` and an optional body `alias` (the same chat's other ID) must match `digits@c.us` or `digits@lid`. The removal is stored per account and session and is returned to browsers as `personalChats` by the history-changes endpoint. Returns `{personalChats:{chatId:timestamp}}`, 400 for other IDs and 503 if it cannot be saved. |
| `POST /api/business-labels/import-preview`, `GET /api/business-labels/history-changes`, `GET /api/business-labels/:id/deletion-preview`, `DELETE /api/business-labels/:id` | See [WhatsApp Business labels](#whatsapp-business-labels). |
| `GET /api/team-chat` (WebSocket upgrade) | Real-time chat between signed-in app users. Requires the access cookie, closes with the sign-in session, and never writes messages to the database. Messages for offline users wait in memory until they sign in. See [Team chat between app users](#team-chat-between-app-users) for rules and frames. |

Login, refresh, and identity responses include the server-assigned `role` (`super_user`, `admin`, or `user`) and `name`, the account's full name from the `NAME` column. `name` falls back to the username when the column is blank. It is held on the live session, and an admin's display-name change through `PATCH /api/admin/users/:id` updates it for that signed-in user straight away. The backend signs HS256 tokens with issuer `wa-bulk`. Access tokens last 15 minutes and are accepted via cookie or Bearer header. Refresh tokens last seven days and are accepted only via the refresh cookie scoped to `/api/auth`. Both cookies are HttpOnly and SameSite Strict. Tabs sharing cookies use the same login, so **one browser holds one Whatix account at a time**: if a second tab signs in as another account, the first tab notices on its next identity check, reloads as that account and shows a notice. To use two accounts side by side, use separate browser profiles or a private window. A sign-in from a different browser takes over the account's session, as described for login above. Login and accepted activity start a five-minute idle interval followed by a two-minute warning. At seven minutes the server closes live streams, revokes both tokens and releases the account even if the browser is closed. Login, refresh, identity lookup, and activity responses include `serverNow`, `idleWarningAt`, and `idleExpiresAt` as Unix timestamps in milliseconds. Refresh and identity lookup preserve the idle deadline, as do messaging and SSE traffic. The backend keeps one session per username and its current refresh token ID in memory. Different accounts can use the shared WAHA chat session concurrently. Restarting releases the reservation and invalidates all existing tokens. This design assumes a single backend process. A multi-instance deployment needs a shared session store with atomic acquisition. Live streams close on logout or access-token expiry, and an authenticated browser can reconnect.

The HTTP proxy streams upstream responses, copies their content type, and applies a 120-second timeout. Upstream authorization failures and connection failures become 502 responses. Invalid client authentication returns 401. Unsupported proxy routes return 404. The browser origin check rejects foreign origins for state-changing requests and allows requests with no Origin header.

## Security hardening

A full security, architecture, database and performance audit ran on 27 November 2026; its reports are in `audit/` (summary PDF `audit/Whatix-Technical-Audit-2026-11-27.pdf`, fixes in `audit/16-REMEDIATION-LOG.md`). The Critical, High and Medium findings were fixed without changing features. What is in place now:

- **Request bodies:** JSON is limited to 1 MB. Only media sends and broadcasts accept up to 52 MB, and those large bodies are read only after the access cookie checks out (401 first otherwise).
- **WAHA requests:** every backend call to WAHA uses `redirect:'error'`, so the API key can never follow a redirect elsewhere. Send bodies are rebuilt from an allowlist per route (`src/send-body.js`).
- **Media links (SSRF):** `src/media-fetch.js` downloads "media link" attachments itself, never WAHA: public addresses only, ports 80 and 443, redirects re-checked, the address actually connected to checked (no DNS rebinding), at most 37 MB.
- **Headers:** helmet on every response; API responses carry a deny-everything Content-Security-Policy (except the proxied WAHA dashboard under `/api/admin/waha-ui`). The built frontend carries its own CSP meta tag. `deploy/reference/Caddyfile` adds `nosniff`, framing protection (`frame-ancestors 'self'`, `X-Frame-Options`) and the other edge headers, and caps request bodies at 60 MB.
- **Origins:** state-changing requests from a foreign `Origin` get 403.
- **Rate limits:** login per IP and per account; 10 password changes per 15 minutes; 120 sends and 60 label additions per minute per user per number; 3 active broadcasts per user, 5,000 recipients each; 8 live streams per user per inbox.
- **Sessions:** refresh-token rotation with replay detection, a 30-second grace for lost responses, sign-in takeover, and sessions ended on password change, ban, rename or admin-flag change.
- **Regular users:** default deny on every inbox; see [WhatsApp numbers](#whatsapp-numbers-and-who-can-use-them).

**Remaining risks.**
- **Secrets:** before exposing the service, replace the bootstrap password and both JWT secrets with private random values. Production refuses the literal default password.
- **Single process:** sessions, grants caches, team chat and waiting notifications live in memory. Run exactly one backend process; a restart signs everyone out and drops queued team-chat messages.
- **Upstream load:** addressed on 28 November 2026; see [Load on WAHA and the database](#load-on-waha-and-the-database).

## Load on WAHA and the database

Changes from 28 November 2026 that cut repeated work without changing what users see:

- **One WAHA socket per inbox** (`src/upstream-hub.js`, audit PERF-02). Every `/api/incoming-text` stream of an inbox shares one WebSocket, opened with the first stream and closed with the last. Each event is parsed once; session-status cache clearing and call tracking run once per event. A regular user's stream copies the event before adding its own media proof. A dropped socket still ends every stream (the browser reconnects and resyncs, as before); failed connection attempts back off 1 s, 2 s, 4 s … up to 30 s however many tabs retry, and a connection that worked and dropped is retried after 1 s. The 8-streams-per-user cap is unchanged.
- **scrypt outside the database queue** (`src/accounts.js`, PERF-01). Sign-in, password change and the password check read the row, hash outside the queue, then re-read it and give up if it changed meanwhile (renamed, deleted or re-passworded). Creating accounts and admin resets hash before the transaction.
- **Assigned-requirement numbers cached** (`numbersFor` in `src/offline-requirements.js`, PERF-03). Every write through the requirement store clears the cache, and an answer read while a write was in flight is not kept. Editing the table directly (support) needs a backend restart, as for grants.
- **Availability probe** (PERF-04). `/api/inbox-availability` accepts a phone answer at most 5 s old (`maxAgeMs` in `src/session-phones.js`), shared by every tab, so WAHA gets one session lookup per number per 5 s instead of one per tab, and a re-paired number is still noticed on about the next probe. A session-status event clears it at once.
- **Session list cached for 5 s** (`directory()` in `src/numbers.js`), with concurrent callers sharing one WAHA call. The Add Number dashboard asks fresh, and its pairing actions and session-status events clear the cache.
- **`/api/session-identity` cached for 30 s** per inbox, cleared on session-status events.

Still open from the audit, all low: PERF-05 (Excel parsing on the event loop), PERF-06 (broadcast state rewrites), PERF-07 (remaining N+1 lookups) and PERF-08 (unbounded responder maps; the AI responders are off).

## Verification and coverage

The latest `npm test` run on 28 November 2026 passed all 53 tests, including `tests/upstream-hub.test.js` (one socket for many streams, ready for late joiners, back-off) and `tests/requirements-cache.test.js` (every write shows in the next `numbersFor` answer). Test files added since 24 November:
- `tests/campaigns.test.js`: the grant store (grants, labels, customers, moving a customer to one user, constraints and cascades), upgrading a version 1 database, and the shared session-phone cache
- `tests/paging.test.js`: server-side paging of users, campaign customers and requirements, including the second number's "Received by" value
- `tests/requirements-admin.test.js`: adding, editing and deleting requirements by hand, with the receiving number
- `tests/security-hardening.test.js`: media links reaching only public addresses; send-body allowlists, limits, refresh grace and replay, password change and the stream cap

`tests/single-session.test.js` now also covers sign-in takeover (`signed_in_elsewhere`) and the first-sign-in password rule: a new account and an admin-reset account are flagged, blocked from other routes (`password_change_required`) while `/auth/me` still works, must pick a different password, and are unblocked after the change. Tests that only need a working account created through the admin API call `completePasswordSetup` from `tests/test-database.js`. The directory leak check now looks for password fields and sealed or scrypt verifiers rather than the word "password", which the boolean flag contains. It also covers deleting a number from the Add Number gateway (401/403 for others, the main number refused before anything reaches WAHA, WAHA's empty 200 passed through) and re-pairing: with a stream open, WAHA's `session.status` event clears the shared phone answer before the browser hears `inbox-status`, so the immediate re-check returns the new account key with no clock advance; the test fails if that clearing is removed.

Earlier files, as recorded on 24 November:
- `tests/team-chat.test.js` and `tests/team-chat-reset.test.js`, described under team chat
- `tests/database-migration.test.js`, which checks the one-time workbook import:
  - an unreadable credential rolls the whole import back and leaves an empty database
  - account and assignment IDs and their high-water marks are preserved, so new rows continue the old numbering
  - migrated passwords still sign in
  - the database reopens without the source workbooks
- `tests/single-session.test.js`, which covers one active session per account, explicit renewal after the idle warning and automatic sign-out
- `tests/coverage.test.js`, which covers who covers which chats and the matching notification visibility

Beyond these, `tests/away-intent.test.js` exercises name-first intake and the saved preview, salaam, withdrawal and clarification, repeat/echo handling, confirmed edits with `OLD:`/`NEW:` tagging, confirmed callback edits, chat ownership, separate and duplicate new projects, and restart recovery.

Replays on 21 November 2026 used the installed qwen3:4b, a temporary workbook and simulated WhatsApp delivery, through a harness kept outside the repository. They covered:
- name-first intake for new and returning customers, including a returning row whose saved name was `You`
- web3, NFT marketplace, AI chatbot and smart-contract requests, each saved with an exact preview
- consecutive edits that stacked `OLD:` lines, and repeated ERP requests that did not create a duplicate row
- the "Alex" name correction, a correction given as a bare name after "The name", and a name that already matched
- "OK" receiving no reply, and "What?" receiving fixed wording

A 23 November 2026 evaluation with qwen3:4b ran 15 name answers and 12 requirement answers in fresh chats:
- **Names:** every genuine name was accepted (Talha Javed, Muhammad Ali, Ayesha, Wei Chen, John Smith, Bilal Ahmed Qureshi). Every non-name was rejected (Batman, Pizza, asdfgh, Website, Mickey Mouse, Test, Xyzzz, "Your mom", "I dont want to tell").
- **Requirements:** genuine requests were saved, including "a website", a smart contract and Instagram marketing. Illegal, off-topic, vague and gibberish answers got the matching fixed reply.

A follow-up evaluation ran 62 real names through the full live flow twice and accepted all of them both times:
- 18 Pakistani, including "M Talha", "Syed Muhammad Ali Raza Naqvi" and "Abdus Salam"
- 12 Indian, including Sikh names
- 12 American, including "Hope Williams", "Mary-Kate Olsen" and "Connor O'Brien"
- 20 from elsewhere, including Vietnamese, Japanese, German, Spanish, Nigerian, Turkish, Russian and Polish names, Arabic "bin" and Dutch "van" particles, and Urdu, Hindi and Chinese scripts

It rejected all 14 non-names in both runs, including Spider Man, Laptop, "No name" and "Qwerty". After the `unsure` verdict was added, all 62 real names were still accepted without a confirmation question. Sunny, Sky, Prince, King Khan and "Tlha Javd" got the confirmation question. Live flows were checked for yes, no then a re-write, "What?" then haan, a second confirmation, and bilkul. Qwen can vary on borderline single words; "Moon", a Korean surname, was accepted in one run and rejected in another. "Elon Musk" was accepted as a real person's name. `tests/away-intent.test.js` covers the validation with a mocked model and the worldwide name forms with the code rules. One draft in the earlier runs hit the 60-second Ollama timeout. The live `data/offline requirements.xlsx` still contains test rows with junk names and requirements written by earlier versions (IDs 1, 4, 5 and 6). They have not been cleaned up. `tests/broadcasts.test.js` covers progress, deduplication, uncertain sends and the 170-recipient example across simulated chunk deadlines.

A separate replay used the installed local Qwen model, a disposable Excel workbook and simulated WhatsApp delivery. It exercised repeated interest, withdrawal, a subsequent acknowledgment and clarification, and a confirmed callback-number change. Actual handset behavior and live outbound delivery were outside that replay.

The server passed Node's syntax check. A local HTTP smoke check using disposable credentials verified health, rejection of anonymous identity requests, login, identity lookup, refresh, logout, and rejection of the revoked refresh cookie. The check confirmed the application requested port 8080 and exercised the routes on an ephemeral loopback port because a Node process already held 8080.

Run `npm test` for the SQLite and mock-WAHA integration suite. It covers login and idle expiry, role restrictions, profile management, username availability, contact photo lookup, voice messages, and sender-only deletion. `tests/assigned-numbers.test.js` covers assigned-number permissions, validation, per-user visibility, updates after account renames and deletions, ID retention and the on-disk columns. The deletion tests exercise personal hiding, rejected upstream requests, and concurrent retries. The earlier production dependency audit reported zero known vulnerabilities in the locked dependency tree at review time. Live WAHA delivery, attachment transfers, and upstream WebSocket traffic were outside the smoke check.

A subsequent live check traced label and history HTTP 502 responses to an outdated backend WAHA key. After synchronizing the local credential and reloading the backend, authenticated requests through port 8080 returned HTTP 200 for labels, chat overview, and a direct chat message page. The configured WAHA session reported WORKING.

## Maintaining this document

Update the affected sections alongside changes to backend behavior, permissions, configuration, storage, API contracts, and test coverage. Distinguish mock tests from live checks and keep credentials and message contents out of examples.
