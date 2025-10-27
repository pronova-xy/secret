// api/store.js
import Stripe from 'stripe';
import admin from 'firebase-admin';
import fetch from 'node-fetch';

// Initialize Firebase Admin (serverless-safe)
const serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN_JSON);
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}
const db = admin.firestore();

// Helper to load Stripe + Discord config from Firestore
async function loadConfig() {
  const configDoc = await db.collection('config').doc('payment').get();
  if (!configDoc.exists) throw new Error('Payment config missing');
  return configDoc.data(); // { stripeKey, discordWebhook }
}

// Disable body parser for Stripe webhooks
export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  try {
    const configData = await loadConfig();
    const stripe = Stripe(configData.stripeKey);

    if (req.method === 'POST' && req.url.includes('create-checkout-session')) {
      // Read JSON body
      const body = await buffer(req);
      const { cartItems } = JSON.parse(body.toString());

      if (!cartItems || !Array.isArray(cartItems) || cartItems.length === 0) {
        return res.status(400).json({ error: 'Cart empty or invalid' });
      }

      const line_items = cartItems.map(item => ({
        price_data: {
          currency: 'usd',
          product_data: { name: item.name },
          unit_amount: item.price * 100,
        },
        quantity: item.quantity || 1,
      }));

      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items,
        mode: 'payment',
        success_url: 'https://pronova.store/success?session_id={CHECKOUT_SESSION_ID}',
        cancel_url: 'https://pronova.store/cancel',
      });

      return res.status(200).json({ url: session.url });
    }

    if (req.method === 'POST' && req.url.includes('webhook')) {
      const sig = req.headers['stripe-signature'];
      const webhookDoc = await db.collection('config').doc('webhookSecret').get();
      if (!webhookDoc.exists) return res.status(400).send('Webhook secret missing');
      const endpointSecret = webhookDoc.data().stripeWebhookSecret;

      const rawBody = await buffer(req);
      let event;
      try {
        event = stripe.webhooks.constructEvent(rawBody, sig, endpointSecret);
      } catch (err) {
        console.log(`Webhook signature verification failed: ${err.message}`);
        return res.status(400).send('Webhook error');
      }

      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        await fetch(configData.discordWebhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: `💸 New purchase! Amount: $${session.amount_total / 100}`
          })
        });
        console.log('Discord webhook sent');
      }

      return res.status(200).json({ received: true });
    }

    return res.status(404).send('Not Found');
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}

// Helper: read raw request body
async function buffer(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}
