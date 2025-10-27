// server.js
'use strict';

const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const fetch = require('node-fetch');
const admin = require('firebase-admin');

// Firebase service account loaded from environment variables
const serviceAccount = {
  type: 'service_account',
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: process.env.FIREBASE_AUTH_URI,
  token_uri: process.env.FIREBASE_TOKEN_URI,
  auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_CERT_URL,
  client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

const app = express();
app.use(cors());
app.use(express.json());

let stripeKey = '';
let discordWebhook = '';
const LOCAL_PORT = 4242;
const PORT = 4242;

// Hardcoded Render URL
const APP_URL = 'https://secret-32j6.onrender.com';

// Load Stripe key + Discord webhook from Firestore at startup
async function loadConfig() {
  const configDoc = await db.collection('config').doc('payment').get();
  if (!configDoc.exists) throw new Error('Payment config missing in Firestore');
  const data = configDoc.data();
  stripeKey = data.stripeKey;
  discordWebhook = data.discordWebhook;
  console.log('Payment config loaded from Firestore');
}
loadConfig();

const stripe = () => Stripe(stripeKey);

// Create Checkout Session
app.post('/create-checkout-session', async (req, res) => {
  const { cartItems } = req.body;

  if (!cartItems || !Array.isArray(cartItems) || cartItems.length === 0) {
    return res.status(400).json({ error: 'Cart is empty or invalid' });
  }

  try {
    const line_items = cartItems.map(item => {
      if (!item.name || !item.price) throw new Error('Invalid item data: missing name or price');
      return {
        price_data: {
          currency: 'usd',
          product_data: { name: item.name },
          unit_amount: item.price * 100,
        },
        quantity: item.quantity || 1,
      };
    });

    const session = await stripe().checkout.sessions.create({
      payment_method_types: ['card'],
      line_items,
      mode: 'payment',
      success_url: `${APP_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_URL}/cancel`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Stripe Webhook
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];

  const webhookDoc = await db.collection('config').doc('webhookSecret').get();
  if (!webhookDoc.exists) return res.status(400).send('Webhook secret missing in Firestore');
  const endpointSecret = webhookDoc.data().stripeWebhookSecret;

  let event;
  try {
    event = stripe().webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error(`Webhook signature verification failed: ${err.message}`);
    return res.status(400).send('Webhook error');
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    try {
      await fetch(discordWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: `💸 New purchase! Amount: $${session.amount_total / 100}`
        })
      });
      console.log('Discord webhook sent');
    } catch (err) {
      console.error('Failed to send Discord webhook:', err);
    }
  }

  res.json({ received: true });
});

app.listen(PORT, () => {
  if (PORT === LOCAL_PORT) {
    console.log(`Server running locally on port ${LOCAL_PORT}`);
  } else {
    console.log(`Server running on Render at port ${PORT}`);
  }
});
