const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const otpStore = new Map();

// SEND OTP
app.post('/api/auth/send-otp', (req, res) => {
  const { phone } = req.body;
  const otp = Math.floor(1000 + Math.random() * 9000).toString();
  otpStore.set(phone, { otp, expires: Date.now() + 300000 });
  console.log(`=== OTP FOR ${phone}: ${otp} ===`);
  res.json({ success: true, debug_otp: otp });
});

// VERIFY OTP - NO DATABASE
app.post('/api/auth/verify-otp', (req, res) => {
  const { phone, otp } = req.body;
  const stored = otpStore.get(phone);
  console.log(`Verify: ${phone} with ${otp}, stored: ${stored?.otp}`);
  if (!stored || stored.otp !== otp || Date.now() > stored.expires) {
    return res.json({ success: false, error: 'Invalid OTP' });
  }
  otpStore.delete(phone);
  // Return user WITHOUT database
  const user = { id: phone, phone: phone };
  res.json({ success: true, user });
});

// CHECK UNLOCK
app.get('/api/unlocks/check', async (req, res) => {
  const { user_id, listing_id } = req.query;
  const { data } = await supabase.from('unlocks')
    .select('*')
    .eq('user_id', user_id)
    .eq('listing_id', listing_id)
    .maybeSingle();
  res.json({ unlocked: !!data, phone: data?.phone_revealed });
});

// POCHI STK
app.post('/api/pochi/stkpush', async (req, res) => {
  const { phone, amount, user_id, listing_id } = req.body;
  try {
    const r = await axios.post('https://api.pochi.co.ke/v1/stkpush', {
      phone, amount, reference: 'PataKeja', callback_url: `${process.env.BACKEND_URL}/api/pochi/callback`
    }, { headers: { 'x-api-key': process.env.POCHI_API_KEY }});
    // Store pending
    await supabase.from('unlocks').upsert([{ 
      user_id, listing_id, amount, 
      mpesa_receipt: r.data.CheckoutRequestID 
    }], { onConflict: 'user_id,listing_id' });
    res.json(r.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POCHI CALLBACK
app.post('/api/pochi/callback', async (req, res) => {
  const { CheckoutRequestID, ResultCode, MpesaReceiptNumber } = req.body;
  if (ResultCode === 0) {
    const { data: unlock } = await supabase.from('unlocks')
      .select('*, listings(caretaker_phone)')
      .eq('mpesa_receipt', CheckoutRequestID).single();
    if (unlock) {
      await supabase.from('unlocks').update({ 
        phone_revealed: unlock.listings.caretaker_phone,
        mpesa_receipt: MpesaReceiptNumber 
      }).eq('id', unlock.id);
    }
  }
  res.json({ ok: true });
});

app.get('/', (req, res) => res.send('Pata Keja API running'));
app.listen(process.env.PORT || 3000);
