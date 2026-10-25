# 12. Database backups

MongoDB Atlas's free tier has **no automatic backups**, so [`.github/workflows/backup.yml`](../.github/workflows/backup.yml) runs every night at **02:00 IST**. It:

1. **Dumps** the production database with `mongodump`, using a **read-only** database user.
2. **Encrypts** the dump with AES-256 and a passphrase only you know. The repository is public, so an unencrypted dump would expose users' emails and bookings.
3. **Tests the restore:** it decrypts the dump, restores it into a throwaway MongoDB, and checks that the users and listings came back. *A backup that has never been restored is a hope, not a backup.*
4. **Keeps** the encrypted file as a workflow artifact for **30 days**.

On pull requests that change the workflow, it runs as a **self-test**. That's the same steps against a throwaway database with known sample data (3 listings), and it must restore exactly those.

## One-time setup

1. **Create a read-only database user** (Atlas):
   - Go to **Database & Network Access → Add New Database User**. Username: `tbc-backup`.
   - Click **Autogenerate Secure Password**, then copy it.
   - Under **Specific Privileges**, choose **`read`** on database **`travelbychance`**, then click **Add User**.
2. **Build its connection string**, in the same shape as the production one:
   `mongodb+srv://tbc-backup:<password>@travelbychance.cnzyair.mongodb.net/travelbychance?retryWrites=true&w=majority`
3. **Choose a passphrase** of 20+ characters and **store it in a password manager**. Without it, the backups can't be opened.
4. **Add two GitHub secrets.** In the repo, go to **Settings → Secrets and variables → Actions → New repository secret**:
   - `BACKUP_DATABASE_URL` = the string from step 2
   - `BACKUP_PASSPHRASE` = the passphrase from step 3
5. **Check it works.** Go to **Actions → Database backup → Run workflow** and wait for the green tick. The log shows `restored database travelbychance: {"users":…,"listings":…}`.

Until the secrets exist, the workflow skips with a notice instead of failing.

## Restoring a backup

1. **Download the file.** Go to **Actions → Database backup →** the run you want **→ Artifacts → db-backup-…** and unzip it to get `db.archive.enc`.
2. **Decrypt it** (Git Bash on Windows includes `openssl`):
   ```bash
   openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in db.archive.enc -out db.archive
   ```
3. **Restore it** with [MongoDB Database Tools](https://www.mongodb.com/try/download/database-tools)' `mongorestore`. Do a **test restore into a different database first**:
   ```bash
   mongorestore --uri="<connection string>" --archive=db.archive --gzip --nsFrom="travelbychance.*" --nsTo="restore_check.*"
   ```
   Once the data looks right, restore over production with `--drop`. That **replaces** the current data, so only do it deliberately.
4. **Delete `db.archive`** when you're done; it's unencrypted.

## Limits

- **Restore point:** at most 24 hours old, and kept for 30 days.
- **Size:** artifacts count towards GitHub's storage. The current database is tiny; at a few hundred MB, move the files to cloud storage instead.
- **Overlap:** a paid Atlas tier has continuous backups with point-in-time restore. If the project moves to one, this workflow becomes a second, independent copy.
