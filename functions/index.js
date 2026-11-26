// Firebase Cloud Functions entry point (2nd gen, Node 22, region asia-south1 / Mumbai).
//   api               -> every /api/** route of the dashboard (Firebase Hosting rewrites /api/** here)
//   followupScheduler -> Cloud Scheduler job that replaces the old setInterval follow-up loop
'use strict';
const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');

if (!admin.apps.length) admin.initializeApp();

// Secrets live in Google Secret Manager (firebase functions:secrets:set NAME). Never in this ZIP.
const secrets = [
  defineSecret('SUPABASE_SERVICE_KEY'),
  defineSecret('BOLNA_API_KEY'),
  defineSecret('WEBHOOK_TOKEN'),
  defineSecret('TALLY_SYNC_TOKEN')
];
const REGION = 'asia-south1';

const { createApp } = require('./lib/app');
const { runAutomaticFollowups } = require('./lib/followup');

const app = createApp({ verifyIdToken: (token) => admin.auth().verifyIdToken(token, true) });

exports.api = onRequest({ region: REGION, secrets, invoker: 'public', memory: '512MiB', timeoutSeconds: 60, maxInstances: 10 }, app);

// 10:00-11:59 and 17:00-18:59 India time, Monday-Friday, every minute (the same windows as before).
// The code re-checks the window itself, and the database lock stops duplicate calls.
exports.followupScheduler = onSchedule({
  schedule: '* 10-11,17-18 * * 1-5', timeZone: 'Asia/Kolkata', region: REGION, secrets,
  timeoutSeconds: 120, retryCount: 0, memory: '256MiB'
}, async () => {
  const result = await runAutomaticFollowups();
  console.log('followupScheduler:', JSON.stringify(result));
});
