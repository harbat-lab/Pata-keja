const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const otpStore = new Map();

app.get('/', (req, res) => res.send('Pata Keja API running ✅'));

// AUTH
app.post('/api/auth/send-otp', (req, res) => {
  const { phone } = req.body;
  const otp = Math.floor(1000 + Math.random() * 9000).toString();
  otpStore.set(phone, { otp, expires: Date.now() + 300000 });
  console.log(`OTP ${phone}: ${otp}`);
  res.json({ success: true, debug_otp: otp });
});

app.post('/api/auth/verify-otp', (req, res) => {
  const { phone, otp } = req.body;
  const stored = otpStore.get(phone);
  if (!stored || stored.otp !== otp) return res.json({ success: false });
  otpStore.delete(phone);
  res.json({ success: true, user: { id: phone, phone } });
});

// DARAJA
async function getToken() {
  const auth = Buffer.from(`${process.env.CONSUMER_KEY}:${process.env.CONSUMER_SECRET}`).toString('base64');
  const { data } = await axios.get('https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials', {
    headers: { Authorization: `Basic ${auth}` }
  });
  return data.access_token;
}

app.post('/api/mpesa/stkpush', async (req, res) => {
  const { phone, amount, user_id, listing_id } = req.body;
  try {
    const token = await getToken();
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0,14);
    const password = Buffer.from(process.env.SHORTCODE + process.env.PASSKEY + timestamp).toString('base64');

    const { data } = await axios.post('https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest', {
      BusinessShortCode: process.env.SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: amount,
      PartyA: phone,
      PartyB: process.env.SHORTCODE,
      PhoneNumber: phone,
      CallBackURL: process.env.CALLBACK_URL,
      AccountReference: 'PataKeja',
      TransactionDesc: 'Unlock contact'
    }, { headers: { Authorization: `Bearer ${token}` }});

    await supabase.from('unlocks').insert([{ user_id, listing_id, mpesa_receipt: data.CheckoutRequestID, amount }]);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

app.post('/api/pochi/stkpush', (req, res, next) => { req.url = '/api/mpesa/stkpush'; app._router.handle(req, res, next); });

// ✅ THIS WAS MISSING - unlock check
app.get('/api/unlocks/check', async (req, res) => {
  const { user_id, listing_id } = req.query;
  const { data: unlock } = await supabase.from('unlocks').select('*').eq('user_id', user_id).eq('listing_id', listing_id).maybeSingle();
  const { data: listing } = await supabase.from('listings').select('caretaker_phone').eq('id', listing_id).single();
  res.json({ unlocked: !!unlock, phone: listing?.caretaker_phone });
});

app.post('/api/mpesa/callback', (req, res) => { res.json({ ResultCode: 0 }); });

app.listen(process.env.PORT || 3000);
