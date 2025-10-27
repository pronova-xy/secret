// server.js
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const fetch = require('node-fetch');
const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

// Load Firebase service account JSON
const serviceAccountPath = path.join(__dirname, 'firebase_admin.json');
if (!fs.existsSync(serviceAccountPath)) throw new Error('firebase_admin.json not found');
const serviceAccount = require(serviceAccountPath);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

const app = express();
app.use(cors());
app.use(express.json());

// Stripe + Discord config
let stripeKey = '';
let discordWebhook = '';

// Load config from Firestore
async function loadConfig() {
  const configDoc = await db.collection('config').doc('payment').get();
  if (!configDoc.exists) throw new Error('Payment config missing');
  const data = configDoc.data();
  stripeKey = data.stripeKey;
  discordWebhook = data.discordWebhook;
  console.log('Payment config loaded');
}

// Helper to get Stripe instance
const stripe = () => Stripe(stripeKey);

// Create checkout session
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
      success_url: 'https://yourdomain.com/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://yourdomain.com/cancel',
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Stripe webhook
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookDoc = await db.collection('config').doc('webhookSecret').get();
  if (!webhookDoc.exists) return res.status(400).send('Webhook secret missing');

  const endpointSecret = webhookDoc.data().stripeWebhookSecret;
  let event;

  try {
    event = stripe().webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.log(`Webhook signature verification failed: ${err.message}`);
    return res.status(400).send('Webhook error');
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    try {
      await fetch(discordWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: `💸 New purchase! Amount: $${session.amount_total / 100}`,
        }),
      });
      console.log('Discord webhook sent');
    } catch (err) {
      console.error('Failed to send Discord webhook:', err);
    }
  }

  res.json({ received: true });
});

// Load config first, then start server
loadConfig().then(() => {
  const PORT = process.env.PORT || 4242;
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}).catch(err => {
  console.error('Failed to load config:', err);
});
