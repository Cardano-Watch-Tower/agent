/**
 * MESSENGER — Communication service for CardanoWatchTower
 *
 * Handles:
 *   - Email notifications via Gmail SMTP (nodemailer)
 *   - Filesystem message queue (inbox/outbox/archive)
 *   - Escalation system (info → warning → critical)
 *   - Daily/monthly report emails
 *   - Inter-agent communication (designer ↔ CWT)
 *
 * Message format: {id, from, to, subject, body, timestamp, priority}
 * Priority levels: info | warning | critical
 */
require('dotenv').config();
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─── Config ─────────────────────────────────────────────────

const GMAIL_USER = process.env.GMAIL_USER || 'cardanowatchtower@gmail.com';
const GMAIL_PASS = process.env.GMAIL_PASS;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'tcl@therefreshcnft.com';
const MESSAGES_DIR = process.env.MESSAGES_DIR || path.join(__dirname, '..', 'messages');

const INBOX_DIR = path.join(MESSAGES_DIR, 'inbox');

// Report frequency: 'hourly' or 'daily'
let reportInterval = process.env.REPORT_INTERVAL || 'hourly';
let lastReportHour = -1;
const OUTBOX_DIR = path.join(MESSAGES_DIR, 'outbox');
const ARCHIVE_DIR = path.join(MESSAGES_DIR, 'archive');

// Ensure directories exist
[MESSAGES_DIR, INBOX_DIR, OUTBOX_DIR, ARCHIVE_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`📁 Created: ${dir}`);
  }
});

// ─── SMTP Transport ─────────────────────────────────────────

let transporter = null;

function getTransporter() {
  if (!transporter && GMAIL_PASS) {
    transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      auth: {
        user: GMAIL_USER,
        pass: GMAIL_PASS
      },
      tls: { rejectUnauthorized: false }
    });
  }
  return transporter;
}

// ─── Email Functions ────────────────────────────────────────

async function sendEmail(to, subject, body) {
  const transport = getTransporter();
  if (!transport) {
    console.log('⚠️  Messenger: No Gmail credentials — email skipped');
    // Still write to outbox so message isn't lost
    writeOutbox(to, subject, body, 'info');
    return false;
  }

  try {
    const result = await transport.sendMail({
      from: `"Cardano Watch Tower" <${GMAIL_USER}>`,
      to,
      subject: `[CWT] ${subject}`,
      text: body,
      html: body.replace(/\n/g, '<br>')
    });
    console.log(`📧 Email sent: "${subject}" → ${to} (${result.messageId})`);
    return true;
  } catch (e) {
    console.error(`📧 Email failed: ${e.message}`);
    // Save to outbox as fallback
    writeOutbox(to, subject, body, 'warning');
    return false;
  }
}

async function sendEmailToOwner(subject, body) {
  return sendEmail(NOTIFY_EMAIL, subject, body);
}

// ─── Filesystem Message Queue ───────────────────────────────

function generateId() {
  return Date.now() + '-' + crypto.randomBytes(4).toString('hex');
}

function writeOutbox(to, subject, body, priority = 'info') {
  const msg = {
    id: generateId(),
    from: 'cwt',
    to,
    subject,
    body,
    timestamp: new Date().toISOString(),
    priority
  };

  const filename = `${msg.id}.json`;
  const filepath = path.join(OUTBOX_DIR, filename);
  fs.writeFileSync(filepath, JSON.stringify(msg, null, 2));
  console.log(`📤 Outbox: ${subject} (${priority})`);
  return msg;
}

function writeInbox(from, subject, body, priority = 'info') {
  const msg = {
    id: generateId(),
    from,
    to: 'cwt',
    subject,
    body,
    timestamp: new Date().toISOString(),
    priority
  };

  const filename = `${msg.id}.json`;
  const filepath = path.join(INBOX_DIR, filename);
  fs.writeFileSync(filepath, JSON.stringify(msg, null, 2));
  return msg;
}

function checkInbox() {
  const messages = [];
  try {
    const files = fs.readdirSync(INBOX_DIR).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const filepath = path.join(INBOX_DIR, file);
        const content = JSON.parse(fs.readFileSync(filepath, 'utf8'));
        messages.push({ ...content, _file: file, _path: filepath });
      } catch (e) {
        console.error(`⚠️  Bad message file: ${file} — ${e.message}`);
      }
    }
  } catch (e) {
    // inbox dir might not exist yet
  }
  return messages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

function archiveMessage(msg) {
  if (!msg._path || !msg._file) return;
  try {
    const archivePath = path.join(ARCHIVE_DIR, msg._file);
    fs.renameSync(msg._path, archivePath);
  } catch (e) {
    console.error(`⚠️  Archive failed: ${e.message}`);
    // Try to delete to prevent re-processing
    try { fs.unlinkSync(msg._path); } catch (e2) {}
  }
}

// ─── Escalation System ──────────────────────────────────────

async function escalate(issue, severity = 'info', details = '') {
  const body = `ESCALATION [${severity.toUpperCase()}]\n\n${issue}\n\n${details ? 'Details:\n' + details : ''}\n\nTimestamp: ${new Date().toISOString()}`;

  // Always log
  const icon = severity === 'critical' ? '🔴' : severity === 'warning' ? '🟡' : 'ℹ️';
  console.log(`${icon} Escalation [${severity}]: ${issue}`);

  // Always write to outbox
  writeOutbox(NOTIFY_EMAIL, `Escalation: ${issue}`, body, severity);

  // Email for warning and critical
  if (severity === 'warning' || severity === 'critical') {
    await sendEmailToOwner(`${severity.toUpperCase()}: ${issue}`, body);
  }

  return severity;
}

// ─── Shutdown Notification ──────────────────────────────────

async function shutdown(reason = 'Unknown') {
  const body = `CWT is shutting down.\n\nReason: ${reason}\nTime: ${new Date().toISOString()}\n\nThe agent will need to be manually restarted if this was not a planned shutdown.`;

  console.log(`🛑 Shutdown initiated: ${reason}`);
  writeOutbox(NOTIFY_EMAIL, `Shutdown: ${reason}`, body, 'critical');

  // Try to send email (best-effort, don't block shutdown)
  try {
    await sendEmailToOwner(`Shutdown: ${reason}`, body);
  } catch (e) {
    console.error(`Could not send shutdown email: ${e.message}`);
  }
}

// ─── Daily Report ───────────────────────────────────────────

async function dailyReport(stats) {
  const date = new Date().toISOString().split('T')[0];
  const uptime = stats.startedAt
    ? Math.round((Date.now() - new Date(stats.startedAt).getTime()) / 3600000) + 'h'
    : 'unknown';

  const body = `
═══════════════════════════════════════════
  CARDANO WATCH TOWER — Daily Report
  Date: ${date}
  Uptime: ${uptime}
═══════════════════════════════════════════

CHAIN MONITORING
  Blocks scanned:    ${stats.blocksScanned || 0}
  Alerts generated:  ${stats.alertsGenerated || 0}
  Largest move:      ${stats.largestMoveAda ? (stats.largestMoveAda / 1e6).toFixed(0) + ' ADA' : 'none'}

SOCIAL
  Tweets posted:     ${stats.tweetsPosted || 0}
  Mentions handled:  ${stats.mentionsHandled || 0}
  Jobs created:      ${stats.jobsCreated || 0}

ENGAGEMENT
  Replies:           ${stats.engagementReplies || 0}
  Likes:             ${stats.engagementLikes || 0}
  Follows:           ${stats.engagementFollows || 0}

HEALTH
  Consecutive errors: ${stats.consecutiveErrors || 0}
  Messages in inbox:  ${checkInbox().length}
  Messages in outbox: ${fs.readdirSync(OUTBOX_DIR).filter(f => f.endsWith('.json')).length}

═══════════════════════════════════════════
  All systems nominal. 👁️
═══════════════════════════════════════════
`.trim();

  await sendEmailToOwner(`Daily Report — ${date}`, body);
  writeOutbox(NOTIFY_EMAIL, `Daily Report — ${date}`, body, 'info');
  console.log(`📊 Daily report sent for ${date}`);
}



async function hourlyReport(stats) {
  const now = new Date();
  const hour = now.getUTCHours();

  // Skip if we already sent this hour
  if (hour === lastReportHour) return false;
  if (reportInterval !== 'hourly') return false;

  lastReportHour = hour;
  const timestamp = now.toISOString();
  const uptime = stats.startedAt
    ? Math.round((Date.now() - new Date(stats.startedAt).getTime()) / 60000) + 'min'
    : 'unknown';

  const body = `CWT Hourly Status — ${timestamp.split('T')[0]} ${String(hour).padStart(2,'0')}:00 UTC

Uptime: ${uptime}
Blocks: ${stats.blocksScanned || 0} | Alerts: ${stats.alertsGenerated || 0}
Tweets: ${stats.tweetsPosted || 0} | Mentions: ${stats.mentionsHandled || 0}
Engagement: ${stats.engagementReplies || 0}R ${stats.engagementLikes || 0}L ${stats.engagementFollows || 0}F
Errors: ${stats.consecutiveErrors || 0}
Inbox: ${checkInbox().length} | Outbox: ${fs.readdirSync(OUTBOX_DIR).filter(f => f.endsWith('.json')).length}

All systems nominal.`;

  await sendEmailToOwner(`Hourly Status — ${String(hour).padStart(2,'0')}:00 UTC`, body);
  console.log(`📊 Hourly report sent (${hour}:00 UTC)`);
  return true;
}

function setReportInterval(interval) {
  if (['hourly', 'daily', 'off'].includes(interval)) {
    reportInterval = interval;
    console.log(`📊 Report interval set to: ${interval}`);
    return true;
  }
  return false;
}

// ─── Design Request/Notification Processing ─────────────────

function requestDesign(template, data, options = {}) {
  const request = {
    id: generateId(),
    template,
    data,
    requestedBy: 'cwt',
    timestamp: new Date().toISOString(),
    options
  };

  // Write to designer's queue directory
  const designerQueue = process.env.DESIGNER_QUEUE || '/home/opc/designer/queue';
  if (!fs.existsSync(designerQueue)) {
    fs.mkdirSync(designerQueue, { recursive: true });
  }

  const filepath = path.join(designerQueue, `${request.id}.json`);
  fs.writeFileSync(filepath, JSON.stringify(request, null, 2));
  console.log(`🎨 Design request queued: ${template} (${request.id})`);
  return request.id;
}

function processDesignNotification(msg) {
  // Designer completed a render — message body contains the output path
  try {
    const data = typeof msg.body === 'string' ? JSON.parse(msg.body) : msg.body;
    if (data.status === 'complete' && data.outputPath) {
      console.log(`🎨 Design complete: ${data.outputPath}`);
      return {
        status: 'complete',
        outputPath: data.outputPath,
        template: data.template,
        requestId: data.requestId
      };
    } else if (data.status === 'failed') {
      console.log(`🎨 Design failed: ${data.error || 'unknown error'}`);
      return { status: 'failed', error: data.error };
    }
  } catch (e) {
    console.error(`⚠️  Bad design notification: ${e.message}`);
  }
  return null;
}

// ─── Message Processing Loop ────────────────────────────────

const messageHandlers = {
  'design-complete': processDesignNotification,
  'design-failed': processDesignNotification
};

function registerHandler(type, handler) {
  messageHandlers[type] = handler;
}

async function processMessages() {
  const messages = checkInbox();
  let processed = 0;

  for (const msg of messages) {
    try {
      const type = msg.subject?.toLowerCase().replace(/\s+/g, '-') || 'unknown';
      const handler = messageHandlers[type];

      if (handler) {
        await handler(msg);
      } else {
        console.log(`📨 Inbox message: ${msg.subject} (from: ${msg.from})`);
      }

      archiveMessage(msg);
      processed++;
    } catch (e) {
      console.error(`⚠️  Error processing message ${msg.id}: ${e.message}`);
      archiveMessage(msg); // archive anyway to prevent infinite retry
    }
  }

  return processed;
}

// ─── Health Check ───────────────────────────────────────────

function isConfigured() {
  return !!(GMAIL_PASS && GMAIL_USER);
}

function status() {
  return {
    configured: isConfigured(),
    gmailUser: GMAIL_USER,
    notifyEmail: NOTIFY_EMAIL,
    messagesDir: MESSAGES_DIR,
    inbox: checkInbox().length,
    outbox: fs.readdirSync(OUTBOX_DIR).filter(f => f.endsWith('.json')).length,
    archive: fs.readdirSync(ARCHIVE_DIR).filter(f => f.endsWith('.json')).length
  };
}

// ─── Exports ────────────────────────────────────────────────

module.exports = {
  // Email
  sendEmail,
  sendEmailToOwner,

  // Message queue
  writeOutbox,
  writeInbox,
  checkInbox,
  archiveMessage,
  processMessages,
  registerHandler,

  // Escalation
  escalate,
  shutdown,

  // Reports
  dailyReport,
  hourlyReport,
  setReportInterval,

  // Designer integration
  requestDesign,
  processDesignNotification,

  // Status
  isConfigured,
  status,

  // Constants
  INBOX_DIR,
  OUTBOX_DIR,
  ARCHIVE_DIR,
  NOTIFY_EMAIL
};
