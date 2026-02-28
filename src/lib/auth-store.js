import crypto from "crypto";
import fs from "fs";
import path from "path";

const DEFAULT_ORG_ID = String(process.env.DEFAULT_ORG_ID || "vancouver").toLowerCase();

function nowIso() {
  return new Date().toISOString();
}

function normalizeOrgId(orgId) {
  return String(orgId || DEFAULT_ORG_ID)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || DEFAULT_ORG_ID;
}

function hashPassword(password, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, "hex") : crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(password || ""), salt, 64);
  return {
    salt: salt.toString("hex"),
    hash: derived.toString("hex"),
  };
}

function verifyPassword(password, saltHex, expectedHashHex) {
  const derived = hashPassword(password, saltHex).hash;
  const a = Buffer.from(derived, "hex");
  const b = Buffer.from(String(expectedHashHex || ""), "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function buildFileStore(cwd) {
  const dir = path.join(cwd, "runs", "auth");
  fs.mkdirSync(dir, { recursive: true });
  const usersFile = path.join(dir, "users.json");
  const sessionsFile = path.join(dir, "sessions.json");
  const resetRequestsFile = path.join(dir, "reset-requests.json");
  const invitesFile = path.join(dir, "invites.json");
  const registrationRequestsFile = path.join(dir, "registration-requests.json");
  const readJson = (file, fallback) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback);
  const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");

  return {
    mode: "file",
    async listUsersByOrg(orgId) {
      const org = normalizeOrgId(orgId);
      return readJson(usersFile, []).filter((u) => u.orgId === org);
    },
    async findUserByEmail(orgId, email) {
      const org = normalizeOrgId(orgId);
      const needle = String(email || "").trim().toLowerCase();
      return readJson(usersFile, []).find((u) => u.orgId === org && u.email === needle) || null;
    },
    async findUserById(userId) {
      return readJson(usersFile, []).find((u) => u.userId === userId) || null;
    },
    async createUser({ orgId, email, name, role, password }) {
      const users = readJson(usersFile, []);
      const normalizedEmail = String(email || "").trim().toLowerCase();
      if (users.some((u) => u.orgId === normalizeOrgId(orgId) && u.email === normalizedEmail)) {
        throw new Error("User already exists.");
      }
      const ph = hashPassword(password);
      const user = {
        userId: crypto.randomUUID(),
        orgId: normalizeOrgId(orgId),
        email: normalizedEmail,
        name: String(name || normalizedEmail),
        role: role === "admin" ? "admin" : "member",
        passwordSalt: ph.salt,
        passwordHash: ph.hash,
        createdAt: nowIso(),
      };
      users.push(user);
      writeJson(usersFile, users);
      return user;
    },
    async updatePasswordForUser(userId, password) {
      const users = readJson(usersFile, []);
      const idx = users.findIndex((u) => u.userId === userId);
      if (idx < 0) throw new Error("User not found.");
      const ph = hashPassword(password);
      users[idx] = {
        ...users[idx],
        passwordSalt: ph.salt,
        passwordHash: ph.hash,
        updatedAt: nowIso(),
      };
      writeJson(usersFile, users);
      return users[idx];
    },
    async createSession({ userId, orgId, ttlHours = 72 }) {
      const sessions = readJson(sessionsFile, []);
      const token = crypto.randomBytes(24).toString("hex");
      const expiresAt = new Date(Date.now() + Number(ttlHours) * 3600 * 1000).toISOString();
      const sess = { token, userId, orgId: normalizeOrgId(orgId), createdAt: nowIso(), expiresAt };
      sessions.push(sess);
      writeJson(sessionsFile, sessions);
      return sess;
    },
    async getSession(token) {
      const sessions = readJson(sessionsFile, []);
      const hit = sessions.find((s) => s.token === token);
      if (!hit) return null;
      if (Date.parse(hit.expiresAt) < Date.now()) return null;
      return hit;
    },
    async revokeSession(token) {
      const sessions = readJson(sessionsFile, []);
      writeJson(
        sessionsFile,
        sessions.filter((s) => s.token !== token)
      );
    },
    async revokeSessionsByUser(userId) {
      const sessions = readJson(sessionsFile, []);
      writeJson(
        sessionsFile,
        sessions.filter((s) => s.userId !== userId)
      );
    },
    async createResetRequest({ orgId, email, requestedFromIp = "", userAgent = "" }) {
      const requests = readJson(resetRequestsFile, []);
      const reqItem = {
        requestId: crypto.randomUUID(),
        orgId: normalizeOrgId(orgId),
        email: String(email || "").trim().toLowerCase(),
        status: "pending",
        requestedAt: nowIso(),
        requestedFromIp: String(requestedFromIp || ""),
        userAgent: String(userAgent || ""),
      };
      requests.push(reqItem);
      writeJson(resetRequestsFile, requests);
      return reqItem;
    },
    async listResetRequestsByOrg(orgId) {
      const org = normalizeOrgId(orgId);
      return readJson(resetRequestsFile, [])
        .filter((r) => r.orgId === org && r.status === "pending")
        .sort((a, b) => Date.parse(String(b.requestedAt || 0)) - Date.parse(String(a.requestedAt || 0)));
    },
    async resolveResetRequest({ orgId, requestId, resolvedByUserId }) {
      const org = normalizeOrgId(orgId);
      const requests = readJson(resetRequestsFile, []);
      const idx = requests.findIndex((r) => r.requestId === requestId && r.orgId === org && r.status === "pending");
      if (idx < 0) throw new Error("Reset request not found.");
      requests[idx] = {
        ...requests[idx],
        status: "resolved",
        resolvedAt: nowIso(),
        resolvedByUserId: String(resolvedByUserId || ""),
      };
      writeJson(resetRequestsFile, requests);
      return requests[idx];
    },
    async createInvite({ orgId, email, name, role, invitedByUserId, ttlHours = 168 }) {
      const invites = readJson(invitesFile, []);
      const token = crypto.randomBytes(24).toString("hex");
      const invite = {
        inviteId: crypto.randomUUID(),
        token,
        orgId: normalizeOrgId(orgId),
        email: String(email || "").trim().toLowerCase(),
        name: String(name || ""),
        role: role === "admin" ? "admin" : "member",
        status: "pending",
        invitedByUserId: String(invitedByUserId || ""),
        createdAt: nowIso(),
        expiresAt: new Date(Date.now() + Number(ttlHours) * 3600 * 1000).toISOString(),
      };
      invites.push(invite);
      writeJson(invitesFile, invites);
      return invite;
    },
    async listInvitesByOrg(orgId) {
      const org = normalizeOrgId(orgId);
      return readJson(invitesFile, [])
        .filter((i) => i.orgId === org)
        .sort((a, b) => Date.parse(String(b.createdAt || 0)) - Date.parse(String(a.createdAt || 0)));
    },
    async getInviteByToken(token) {
      const invites = readJson(invitesFile, []);
      const invite = invites.find((i) => i.token === String(token || ""));
      if (!invite) return null;
      if (invite.status !== "pending") return invite;
      if (Date.parse(String(invite.expiresAt || "")) < Date.now()) {
        const idx = invites.findIndex((i) => i.inviteId === invite.inviteId);
        if (idx >= 0) {
          invites[idx] = { ...invites[idx], status: "expired", updatedAt: nowIso() };
          writeJson(invitesFile, invites);
          return invites[idx];
        }
      }
      return invite;
    },
    async acceptInvite({ token, password, name }) {
      const invites = readJson(invitesFile, []);
      const idx = invites.findIndex((i) => i.token === String(token || ""));
      if (idx < 0) throw new Error("Invite not found.");
      const invite = invites[idx];
      if (invite.status !== "pending") throw new Error("Invite is no longer active.");
      if (Date.parse(String(invite.expiresAt || "")) < Date.now()) {
        invites[idx] = { ...invite, status: "expired", updatedAt: nowIso() };
        writeJson(invitesFile, invites);
        throw new Error("Invite has expired.");
      }
      const existing = await this.findUserByEmail(invite.orgId, invite.email);
      if (existing) throw new Error("User already exists for this email.");
      const user = await this.createUser({
        orgId: invite.orgId,
        email: invite.email,
        name: String(name || invite.name || invite.email),
        role: invite.role === "admin" ? "admin" : "member",
        password,
      });
      invites[idx] = {
        ...invite,
        status: "accepted",
        acceptedAt: nowIso(),
        acceptedUserId: user.userId,
        updatedAt: nowIso(),
      };
      writeJson(invitesFile, invites);
      return { invite: invites[idx], user };
    },
    async revokeInvite({ orgId, inviteId }) {
      const org = normalizeOrgId(orgId);
      const invites = readJson(invitesFile, []);
      const idx = invites.findIndex((i) => i.inviteId === String(inviteId || "") && i.orgId === org);
      if (idx < 0) throw new Error("Invite not found.");
      invites[idx] = {
        ...invites[idx],
        status: invites[idx].status === "accepted" ? "accepted" : "revoked",
        revokedAt: nowIso(),
        updatedAt: nowIso(),
      };
      writeJson(invitesFile, invites);
      return invites[idx];
    },
    async deleteInvite({ orgId, inviteId }) {
      const org = normalizeOrgId(orgId);
      const invites = readJson(invitesFile, []);
      const idx = invites.findIndex((i) => i.inviteId === String(inviteId || "") && i.orgId === org);
      if (idx < 0) throw new Error("Invite not found.");
      const invite = invites[idx];
      invites.splice(idx, 1);
      writeJson(invitesFile, invites);
      return invite;
    },
    async deleteUserById({ orgId, userId }) {
      const org = normalizeOrgId(orgId);
      const users = readJson(usersFile, []);
      const idx = users.findIndex((u) => u.userId === String(userId || "") && u.orgId === org);
      if (idx < 0) throw new Error("User not found.");
      const user = users[idx];
      users.splice(idx, 1);
      writeJson(usersFile, users);
      await this.revokeSessionsByUser(user.userId);
      return user;
    },
    async createRegistrationRequest({ orgId, email, name, requestedFromIp = "", userAgent = "" }) {
      const requests = readJson(registrationRequestsFile, []);
      const reqItem = {
        requestId: crypto.randomUUID(),
        orgId: normalizeOrgId(orgId),
        email: String(email || "").trim().toLowerCase(),
        name: String(name || ""),
        status: "pending",
        requestedAt: nowIso(),
        requestedFromIp: String(requestedFromIp || ""),
        userAgent: String(userAgent || ""),
      };
      requests.push(reqItem);
      writeJson(registrationRequestsFile, requests);
      return reqItem;
    },
    async listRegistrationRequestsByOrg(orgId) {
      const org = normalizeOrgId(orgId);
      return readJson(registrationRequestsFile, [])
        .filter((r) => r.orgId === org)
        .sort((a, b) => Date.parse(String(b.requestedAt || 0)) - Date.parse(String(a.requestedAt || 0)));
    },
    async approveRegistrationRequest({ orgId, requestId, resolvedByUserId, inviteId = "", inviteToken = "" }) {
      const org = normalizeOrgId(orgId);
      const requests = readJson(registrationRequestsFile, []);
      const idx = requests.findIndex((r) => r.requestId === String(requestId || "") && r.orgId === org && r.status === "pending");
      if (idx < 0) throw new Error("Registration request not found.");
      requests[idx] = {
        ...requests[idx],
        status: "approved",
        resolvedAt: nowIso(),
        resolvedByUserId: String(resolvedByUserId || ""),
        inviteId: String(inviteId || ""),
        inviteToken: String(inviteToken || ""),
      };
      writeJson(registrationRequestsFile, requests);
      return requests[idx];
    },
    async rejectRegistrationRequest({ orgId, requestId, resolvedByUserId, reason = "" }) {
      const org = normalizeOrgId(orgId);
      const requests = readJson(registrationRequestsFile, []);
      const idx = requests.findIndex((r) => r.requestId === String(requestId || "") && r.orgId === org && r.status === "pending");
      if (idx < 0) throw new Error("Registration request not found.");
      requests[idx] = {
        ...requests[idx],
        status: "rejected",
        resolvedAt: nowIso(),
        resolvedByUserId: String(resolvedByUserId || ""),
        reason: String(reason || ""),
      };
      writeJson(registrationRequestsFile, requests);
      return requests[idx];
    },
  };
}

async function buildFirestoreStore() {
  const appMod = await import("firebase-admin/app");
  const dbMod = await import("firebase-admin/firestore");
  const { getApps, initializeApp, applicationDefault } = appMod;
  const { getFirestore, FieldValue } = dbMod;
  if (getApps().length === 0) {
    initializeApp({ credential: applicationDefault() });
  }
  const db = getFirestore();
  const prefix = process.env.FIRESTORE_NAMESPACE || "dv_agent";
  const usersCol = `${prefix}_auth_users`;
  const sessionsCol = `${prefix}_auth_sessions`;
  const resetRequestsCol = `${prefix}_auth_reset_requests`;
  const invitesCol = `${prefix}_auth_invites`;
  const registrationRequestsCol = `${prefix}_auth_registration_requests`;

  return {
    mode: "firestore",
    async listUsersByOrg(orgId) {
      const org = normalizeOrgId(orgId);
      const snap = await db.collection(usersCol).where("orgId", "==", org).get();
      return snap.docs
        .map((d) => ({ userId: d.id, ...(d.data() || {}) }))
        .sort((a, b) => Date.parse(String(b.createdAt || 0)) - Date.parse(String(a.createdAt || 0)));
    },
    async findUserByEmail(orgId, email) {
      const org = normalizeOrgId(orgId);
      const needle = String(email || "").trim().toLowerCase();
      const snap = await db.collection(usersCol).where("orgId", "==", org).where("email", "==", needle).limit(1).get();
      if (snap.empty) return null;
      const d = snap.docs[0];
      return { userId: d.id, ...(d.data() || {}) };
    },
    async findUserById(userId) {
      const d = await db.collection(usersCol).doc(userId).get();
      if (!d.exists) return null;
      return { userId: d.id, ...(d.data() || {}) };
    },
    async createUser({ orgId, email, name, role, password }) {
      const normalizedEmail = String(email || "").trim().toLowerCase();
      const existing = await this.findUserByEmail(orgId, normalizedEmail);
      if (existing) throw new Error("User already exists.");
      const ph = hashPassword(password);
      const ref = db.collection(usersCol).doc();
      const user = {
        orgId: normalizeOrgId(orgId),
        email: normalizedEmail,
        name: String(name || normalizedEmail),
        role: role === "admin" ? "admin" : "member",
        passwordSalt: ph.salt,
        passwordHash: ph.hash,
        createdAt: nowIso(),
        updatedAt: FieldValue.serverTimestamp(),
      };
      await ref.set(user);
      return { userId: ref.id, ...user };
    },
    async updatePasswordForUser(userId, password) {
      const ref = db.collection(usersCol).doc(String(userId || ""));
      const snap = await ref.get();
      if (!snap.exists) throw new Error("User not found.");
      const ph = hashPassword(password);
      await ref.set(
        {
          passwordSalt: ph.salt,
          passwordHash: ph.hash,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      const data = (await ref.get()).data() || {};
      return { userId: ref.id, ...data };
    },
    async createSession({ userId, orgId, ttlHours = 72 }) {
      const token = crypto.randomBytes(24).toString("hex");
      const expiresAt = new Date(Date.now() + Number(ttlHours) * 3600 * 1000).toISOString();
      await db.collection(sessionsCol).doc(token).set({
        userId,
        orgId: normalizeOrgId(orgId),
        createdAt: nowIso(),
        expiresAt,
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { token, userId, orgId: normalizeOrgId(orgId), expiresAt };
    },
    async getSession(token) {
      const d = await db.collection(sessionsCol).doc(String(token || "")).get();
      if (!d.exists) return null;
      const data = d.data() || {};
      if (Date.parse(String(data.expiresAt || "")) < Date.now()) return null;
      return { token, ...data };
    },
    async revokeSession(token) {
      await db.collection(sessionsCol).doc(String(token || "")).delete();
    },
    async revokeSessionsByUser(userId) {
      const snap = await db.collection(sessionsCol).where("userId", "==", String(userId || "")).get();
      if (snap.empty) return;
      const batch = db.batch();
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
    },
    async createResetRequest({ orgId, email, requestedFromIp = "", userAgent = "" }) {
      const ref = db.collection(resetRequestsCol).doc();
      const reqItem = {
        orgId: normalizeOrgId(orgId),
        email: String(email || "").trim().toLowerCase(),
        status: "pending",
        requestedAt: nowIso(),
        requestedFromIp: String(requestedFromIp || ""),
        userAgent: String(userAgent || ""),
        updatedAt: FieldValue.serverTimestamp(),
      };
      await ref.set(reqItem);
      return { requestId: ref.id, ...reqItem };
    },
    async listResetRequestsByOrg(orgId) {
      const org = normalizeOrgId(orgId);
      const snap = await db
        .collection(resetRequestsCol)
        .where("orgId", "==", org)
        .where("status", "==", "pending")
        .get();
      return snap.docs
        .map((d) => ({ requestId: d.id, ...(d.data() || {}) }))
        .sort((a, b) => Date.parse(String(b.requestedAt || 0)) - Date.parse(String(a.requestedAt || 0)));
    },
    async resolveResetRequest({ orgId, requestId, resolvedByUserId }) {
      const ref = db.collection(resetRequestsCol).doc(String(requestId || ""));
      const snap = await ref.get();
      if (!snap.exists) throw new Error("Reset request not found.");
      const data = snap.data() || {};
      if (normalizeOrgId(data.orgId) !== normalizeOrgId(orgId) || data.status !== "pending") {
        throw new Error("Reset request not found.");
      }
      await ref.set(
        {
          status: "resolved",
          resolvedAt: nowIso(),
          resolvedByUserId: String(resolvedByUserId || ""),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      return { requestId: ref.id, ...(await ref.get()).data() };
    },
    async createInvite({ orgId, email, name, role, invitedByUserId, ttlHours = 168 }) {
      const ref = db.collection(invitesCol).doc();
      const token = crypto.randomBytes(24).toString("hex");
      const invite = {
        token,
        orgId: normalizeOrgId(orgId),
        email: String(email || "").trim().toLowerCase(),
        name: String(name || ""),
        role: role === "admin" ? "admin" : "member",
        status: "pending",
        invitedByUserId: String(invitedByUserId || ""),
        createdAt: nowIso(),
        expiresAt: new Date(Date.now() + Number(ttlHours) * 3600 * 1000).toISOString(),
        updatedAt: FieldValue.serverTimestamp(),
      };
      await ref.set(invite);
      return { inviteId: ref.id, ...invite };
    },
    async listInvitesByOrg(orgId) {
      const org = normalizeOrgId(orgId);
      const snap = await db.collection(invitesCol).where("orgId", "==", org).get();
      return snap.docs
        .map((d) => ({ inviteId: d.id, ...(d.data() || {}) }))
        .sort((a, b) => Date.parse(String(b.createdAt || 0)) - Date.parse(String(a.createdAt || 0)));
    },
    async getInviteByToken(token) {
      const snap = await db.collection(invitesCol).where("token", "==", String(token || "")).limit(1).get();
      if (snap.empty) return null;
      const d = snap.docs[0];
      const invite = { inviteId: d.id, ...(d.data() || {}) };
      if (invite.status === "pending" && Date.parse(String(invite.expiresAt || "")) < Date.now()) {
        await d.ref.set(
          { status: "expired", updatedAt: FieldValue.serverTimestamp() },
          { merge: true }
        );
        return { ...invite, status: "expired" };
      }
      return invite;
    },
    async acceptInvite({ token, password, name }) {
      const snap = await db.collection(invitesCol).where("token", "==", String(token || "")).limit(1).get();
      if (snap.empty) throw new Error("Invite not found.");
      const d = snap.docs[0];
      const invite = { inviteId: d.id, ...(d.data() || {}) };
      if (invite.status !== "pending") throw new Error("Invite is no longer active.");
      if (Date.parse(String(invite.expiresAt || "")) < Date.now()) {
        await d.ref.set({ status: "expired", updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        throw new Error("Invite has expired.");
      }
      const existing = await this.findUserByEmail(invite.orgId, invite.email);
      if (existing) throw new Error("User already exists for this email.");
      const user = await this.createUser({
        orgId: invite.orgId,
        email: invite.email,
        name: String(name || invite.name || invite.email),
        role: invite.role === "admin" ? "admin" : "member",
        password,
      });
      await d.ref.set(
        {
          status: "accepted",
          acceptedAt: nowIso(),
          acceptedUserId: user.userId,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      return { invite: { ...invite, status: "accepted", acceptedUserId: user.userId }, user };
    },
    async revokeInvite({ orgId, inviteId }) {
      const ref = db.collection(invitesCol).doc(String(inviteId || ""));
      const snap = await ref.get();
      if (!snap.exists) throw new Error("Invite not found.");
      const data = snap.data() || {};
      if (normalizeOrgId(data.orgId) !== normalizeOrgId(orgId)) throw new Error("Invite not found.");
      const status = String(data.status || "");
      await ref.set(
        {
          status: status === "accepted" ? "accepted" : "revoked",
          revokedAt: nowIso(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      const updated = (await ref.get()).data() || {};
      return { inviteId: ref.id, ...updated };
    },
    async deleteInvite({ orgId, inviteId }) {
      const ref = db.collection(invitesCol).doc(String(inviteId || ""));
      const snap = await ref.get();
      if (!snap.exists) throw new Error("Invite not found.");
      const data = snap.data() || {};
      if (normalizeOrgId(data.orgId) !== normalizeOrgId(orgId)) throw new Error("Invite not found.");
      await ref.delete();
      return { inviteId: ref.id, ...data };
    },
    async deleteUserById({ orgId, userId }) {
      const org = normalizeOrgId(orgId);
      const ref = db.collection(usersCol).doc(String(userId || ""));
      const snap = await ref.get();
      if (!snap.exists) throw new Error("User not found.");
      const data = snap.data() || {};
      if (normalizeOrgId(data.orgId) !== org) throw new Error("User not found.");
      await ref.delete();
      await this.revokeSessionsByUser(String(userId || ""));
      return { userId: ref.id, ...data };
    },
    async createRegistrationRequest({ orgId, email, name, requestedFromIp = "", userAgent = "" }) {
      const ref = db.collection(registrationRequestsCol).doc();
      const reqItem = {
        orgId: normalizeOrgId(orgId),
        email: String(email || "").trim().toLowerCase(),
        name: String(name || ""),
        status: "pending",
        requestedAt: nowIso(),
        requestedFromIp: String(requestedFromIp || ""),
        userAgent: String(userAgent || ""),
        updatedAt: FieldValue.serverTimestamp(),
      };
      await ref.set(reqItem);
      return { requestId: ref.id, ...reqItem };
    },
    async listRegistrationRequestsByOrg(orgId) {
      const org = normalizeOrgId(orgId);
      const snap = await db.collection(registrationRequestsCol).where("orgId", "==", org).get();
      return snap.docs
        .map((d) => ({ requestId: d.id, ...(d.data() || {}) }))
        .sort((a, b) => Date.parse(String(b.requestedAt || 0)) - Date.parse(String(a.requestedAt || 0)));
    },
    async approveRegistrationRequest({ orgId, requestId, resolvedByUserId, inviteId = "", inviteToken = "" }) {
      const ref = db.collection(registrationRequestsCol).doc(String(requestId || ""));
      const snap = await ref.get();
      if (!snap.exists) throw new Error("Registration request not found.");
      const data = snap.data() || {};
      if (normalizeOrgId(data.orgId) !== normalizeOrgId(orgId) || data.status !== "pending") {
        throw new Error("Registration request not found.");
      }
      await ref.set(
        {
          status: "approved",
          resolvedAt: nowIso(),
          resolvedByUserId: String(resolvedByUserId || ""),
          inviteId: String(inviteId || ""),
          inviteToken: String(inviteToken || ""),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      return { requestId: ref.id, ...(await ref.get()).data() };
    },
    async rejectRegistrationRequest({ orgId, requestId, resolvedByUserId, reason = "" }) {
      const ref = db.collection(registrationRequestsCol).doc(String(requestId || ""));
      const snap = await ref.get();
      if (!snap.exists) throw new Error("Registration request not found.");
      const data = snap.data() || {};
      if (normalizeOrgId(data.orgId) !== normalizeOrgId(orgId) || data.status !== "pending") {
        throw new Error("Registration request not found.");
      }
      await ref.set(
        {
          status: "rejected",
          resolvedAt: nowIso(),
          resolvedByUserId: String(resolvedByUserId || ""),
          reason: String(reason || ""),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      return { requestId: ref.id, ...(await ref.get()).data() };
    },
  };
}

export async function createAuthStore({ cwd }) {
  const backend = (process.env.DATA_BACKEND || "file").toLowerCase();
  if (backend !== "firestore") return buildFileStore(cwd);
  try {
    return await buildFirestoreStore();
  } catch {
    return buildFileStore(cwd);
  }
}

export function getDefaultOrgId() {
  return normalizeOrgId(process.env.DEFAULT_ORG_ID || DEFAULT_ORG_ID);
}

export async function ensureBootstrapAdmin(store) {
  const email = String(process.env.AUTH_BOOTSTRAP_EMAIL || "").trim().toLowerCase();
  const password = String(process.env.AUTH_BOOTSTRAP_PASSWORD || "");
  if (!email || !password) return null;
  const orgId = getDefaultOrgId();
  const existing = await store.findUserByEmail(orgId, email);
  if (existing) return existing;
  return store.createUser({
    orgId,
    email,
    name: process.env.AUTH_BOOTSTRAP_NAME || "Admin",
    role: "admin",
    password,
  });
}

export { normalizeOrgId, verifyPassword };
