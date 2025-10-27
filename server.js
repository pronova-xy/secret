const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const fetch = require('node-fetch');
const admin = require('firebase-admin');

const serviceAccount = require('./firebase_admin.json'); // your Firebase admin key
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

const app = express();
app.use(cors());
app.use(express.json());

let stripeKey = '';
let discordWebhook = '';

// Load Stripe key + Discord webhook from Firestore at startup
async function loadConfig() {
  const configDoc = await db.collection('config').doc('payment').get();
  if (!configDoc.exists) throw new Error('Payment config missing');
  const data = configDoc.data();
  stripeKey = data.stripeKey;
  discordWebhook = data.discordWebhook;
  console.log('Payment config loaded');
}
loadConfig();

let stripe = () => Stripe(stripeKey);

app.post('/create-checkout-session', async (req, res) => {
  

  const { cartItems } = req.body;

  if (!cartItems || !Array.isArray(cartItems) || cartItems.length === 0) {
    return res.status(400).json({ error: 'Cart is empty or invalid' });
  }
  try {
    const line_items = cartItems.map(item => {
      if (!item.name || !item.price) {
        throw new Error('Invalid item data: missing name or price');
      }
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
      success_url: 'http://localhost:3000/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'http://localhost:3000/cancel',
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe error:', err);
    res.status(500).json({ error: err.message });
  }
});


// Stripe webhook for payment confirmation
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
          content: `💸 New purchase! Amount: $${session.amount_total/100}`
        })
      });
      console.log('Discord webhook sent');
    } catch (err) {
      console.error('Failed to send Discord webhook:', err);
    }
  }

  res.json({ received: true });
});

app.listen(4242, () => console.log('Server running on port 4242'));
