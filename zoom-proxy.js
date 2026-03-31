/**
 * Creator Connect — API Proxy Server
 * 
 * Handles Zoom API + Stripe payment processing.
 * Credentials stored in memory only (never exposed to client).
 * 
 * Usage:
 *   ZOOM_ACCOUNT_ID=xxx ZOOM_CLIENT_ID=yyy ZOOM_CLIENT_SECRET=zzz \
 *   STRIPE_SECRET_KEY=sk_xxx npm run proxy
 */

import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';

const app = express();
const PORT = process.env.PORT || 3004;

const ALLOWED_ORIGINS = [
  'http://localhost:8000',
  'http://127.0.0.1:8000',
  'https://creator-connect-dsbd-77.web.app',
  'https://creator-connect-dsbd-77.firebaseapp.com'
];

app.use(cors({ origin: ALLOWED_ORIGINS }));

// Stripe webhook needs raw body, so we handle it before json middleware
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), handleStripeWebhook);

app.use(express.json());

// ========================
// CREDENTIAL STORES
// ========================
let zoomCredentials = {
  accountId: process.env.ZOOM_ACCOUNT_ID || '',
  clientId: process.env.ZOOM_CLIENT_ID || '',
  clientSecret: process.env.ZOOM_CLIENT_SECRET || ''
};

let stripeConfig = {
  secretKey: process.env.STRIPE_SECRET_KEY || '',
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
  publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || ''
};

// In-memory store for successful payments (in production, use a database)
const payments = [];

function getStripe() {
  if (!stripeConfig.secretKey) return null;
  return new Stripe(stripeConfig.secretKey);
}

// ========================
// HEALTH CHECK
// ========================
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    hasZoomCredentials: !!(zoomCredentials.accountId && zoomCredentials.clientId && zoomCredentials.clientSecret),
    hasStripeKey: !!stripeConfig.secretKey,
    stripeMode: stripeConfig.secretKey?.startsWith('sk_live') ? 'live' : 'test'
  });
});

// ========================
// ZOOM ENDPOINTS
// ========================
app.post('/api/zoom/credentials', (req, res) => {
  const { accountId, clientId, clientSecret } = req.body;
  if (!accountId || !clientId || !clientSecret) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  zoomCredentials = { accountId, clientId, clientSecret };
  res.json({ status: 'credentials_updated' });
});

async function getZoomAccessToken() {
  const { accountId, clientId, clientSecret } = zoomCredentials;
  if (!accountId || !clientId || !clientSecret) {
    throw new Error('Zoom credentials not configured.');
  }
  const credentials = Buffer.from(clientId + ':' + clientSecret).toString('base64');
  const response = await fetch('https://zoom.us/oauth/token', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + credentials,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=account_credentials&account_id=' + accountId
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error('Zoom OAuth failed (' + response.status + '): ' + err);
  }
  const data = await response.json();
  return data.access_token;
}

app.post('/api/zoom/create-meeting', async (req, res) => {
  try {
    const token = await getZoomAccessToken();
    const { topic, duration, startTime } = req.body;
    const meetingPayload = {
      topic: topic || 'Creator Connect Meeting',
      type: startTime ? 2 : 1,
      duration: duration || 30,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      settings: {
        join_before_host: true,
        waiting_room: false,
        mute_upon_entry: true,
        auto_recording: 'none'
      }
    };
    if (startTime) meetingPayload.start_time = startTime;
    const response = await fetch('https://api.zoom.us/v2/users/me/meetings', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(meetingPayload)
    });
    if (!response.ok) {
      const err = await response.text();
      throw new Error('Zoom API error (' + response.status + '): ' + err);
    }
    const meeting = await response.json();
    res.json({
      success: true,
      meetingId: meeting.id,
      joinUrl: meeting.join_url,
      passcode: meeting.password || '',
      topic: meeting.topic
    });
  } catch (error) {
    console.error('Zoom meeting creation failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ========================
// STRIPE ENDPOINTS
// ========================

// Update Stripe credentials at runtime
app.post('/api/stripe/config', (req, res) => {
  const { secretKey, publishableKey, webhookSecret } = req.body;
  if (secretKey) stripeConfig.secretKey = secretKey;
  if (publishableKey) stripeConfig.publishableKey = publishableKey;
  if (webhookSecret) stripeConfig.webhookSecret = webhookSecret;
  res.json({
    status: 'updated',
    hasKey: !!stripeConfig.secretKey,
    mode: stripeConfig.secretKey?.startsWith('sk_live') ? 'live' : 'test'
  });
});

// Get Stripe public config
app.get('/api/stripe/public-config', (req, res) => {
  res.json({
    publishableKey: stripeConfig.publishableKey,
    hasSecretKey: !!stripeConfig.secretKey
  });
});

// Create Checkout Session
app.post('/api/stripe/create-checkout', async (req, res) => {
  try {
    const stripe = getStripe();
    if (!stripe) {
      return res.status(400).json({
        error: 'Stripe not configured. Add your Secret Key in Settings.'
      });
    }

    const {
      type, amount, currency, adTitle, adDuration,
      meetingName, meetingId, customerEmail, successUrl, cancelUrl
    } = req.body;

    const amountCents = Math.round((amount || 5) * 100);
    let lineItems;
    let metadata = { type };

    if (type === 'ad_rental') {
      lineItems = [{
        price_data: {
          currency: currency || 'usd',
          product_data: {
            name: 'Ad Space Rental: ' + (adTitle || 'Ad Slot'),
            description: (adDuration || 7) + ' day ad placement on Creator Connect'
          },
          unit_amount: amountCents
        },
        quantity: 1
      }];
      metadata.adTitle = adTitle;
      metadata.adDuration = String(adDuration || 7);
    } else if (type === 'meeting_ticket') {
      lineItems = [{
        price_data: {
          currency: currency || 'usd',
          product_data: {
            name: 'Meeting Access: ' + (meetingName || 'Live Session'),
            description: 'One-time access to the creator\'s live Zoom meeting'
          },
          unit_amount: amountCents
        },
        quantity: 1
      }];
      metadata.meetingId = meetingId || '';
      metadata.meetingName = meetingName || '';
    } else if (type === 'tip') {
      lineItems = [{
        price_data: {
          currency: currency || 'usd',
          product_data: {
            name: 'Creator Tip',
            description: 'Support this creator with a tip!'
          },
          unit_amount: amountCents
        },
        quantity: 1
      }];
    } else {
      return res.status(400).json({ error: 'Invalid type. Use: ad_rental, meeting_ticket, or tip' });
    }

    const sessionParams = {
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      success_url: successUrl || 'http://localhost:8000/?payment=success&session_id={CHECKOUT_SESSION_ID}',
      cancel_url: cancelUrl || 'http://localhost:8000/?payment=cancelled',
      metadata
    };

    if (customerEmail) {
      sessionParams.customer_email = customerEmail;
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    res.json({
      success: true,
      sessionId: session.id,
      url: session.url
    });

  } catch (error) {
    console.error('Stripe checkout error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Verify a payment session
app.get('/api/stripe/verify-session', async (req, res) => {
  try {
    const stripe = getStripe();
    if (!stripe) return res.status(400).json({ error: 'Stripe not configured' });
    const { session_id } = req.query;
    if (!session_id) return res.status(400).json({ error: 'Missing session_id' });
    const session = await stripe.checkout.sessions.retrieve(session_id);
    res.json({
      paid: session.payment_status === 'paid',
      amount: session.amount_total / 100,
      currency: session.currency,
      type: session.metadata?.type || 'unknown',
      metadata: session.metadata,
      customerEmail: session.customer_email
    });
  } catch (error) {
    console.error('Session verify error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Get recent payments
app.get('/api/stripe/payments', (req, res) => {
  res.json({ payments: payments.slice(-50) });
});

// Stripe Webhook handler
async function handleStripeWebhook(req, res) {
  try {
    const stripe = getStripe();
    if (!stripe) return res.status(400).send('Stripe not configured');
    let event;
    if (stripeConfig.webhookSecret) {
      const sig = req.headers['stripe-signature'];
      event = stripe.webhooks.constructEvent(req.body, sig, stripeConfig.webhookSecret);
    } else {
      event = JSON.parse(req.body.toString());
    }
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const payment = {
        id: session.id,
        type: session.metadata?.type || 'unknown',
        amount: session.amount_total / 100,
        currency: session.currency,
        email: session.customer_email,
        metadata: session.metadata,
        timestamp: new Date().toISOString()
      };
      payments.push(payment);
      console.log('Payment received: $' + payment.amount + ' (' + payment.type + ')');
    }
    res.json({ received: true });
  } catch (error) {
    console.error('Webhook error:', error.message);
    res.status(400).send('Webhook Error: ' + error.message);
  }
}

// ========================
// START SERVER
// ========================
app.listen(PORT, () => {
  console.log('Creator Connect Proxy running on port ' + PORT);
  console.log('Health: http://localhost:' + PORT + '/api/health');
  if (zoomCredentials.accountId) {
    console.log('Zoom credentials loaded');
  } else {
    console.log('No Zoom credentials - configure via Settings');
  }
  if (stripeConfig.secretKey) {
    const mode = stripeConfig.secretKey.startsWith('sk_live') ? 'LIVE' : 'TEST';
    console.log('Stripe configured (' + mode + ' mode)');
  } else {
    console.log('No Stripe key - configure via Settings');
  }
});

