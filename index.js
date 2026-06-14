const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const bodyParser = require('body-parser');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

const port = process.env.PORT || 3000;

// Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Health check
app.get('/', (req, res) => {
  res.send('PataKeja API is running');
});

// M-Pesa STK Push endpoint
app.post('/stkpush', async (req, res) => {
  try {
    const { phone, amount } = req.body;
    const auth = Buffer.from(`${process.env.CONSUMER_KEY}:${process.env.CONSUMER_SECRET}`).toString('base64');
    
    // Get access token
    const tokenRes = await axios.get('https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials', {
      headers: { Authorization: `Basic ${auth}` }
    });
    const token = tokenRes.data.access_token;

    // STK Push
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, -3);
    const password = Buffer.from(`${process.env.SHORTCODE}${process.env.PASSKEY}${timestamp}`).toString('base64');

    const stkRes = await axios.post('https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest', {
      BusinessShortCode: process.env.SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: amount,
      PartyA: phone,
      PartyB: process.env.SHORTCODE,
      PhoneNumber: phone,
      CallBackURL: process.env.CALLBACK_URL,
      AccountReference: "PataKeja",
      TransactionDesc: "Payment"
    }, {
      headers: { Authorization: `Bearer ${token}` }
    });

    res.json(stkRes.data);
  } catch (error) {
    res.status(500).json({ error: error.response?.data || error.message });
  }
});

// M-Pesa Callback
app.post('/mpesa/callback', async (req, res) => {
  console.log('M-Pesa Callback:', JSON.stringify(req.body));
  
  const callback = req.body.Body?.stkCallback;
  if (callback?.ResultCode === 0) {
    const metadata = callback.CallbackMetadata.Item;
    const amount = metadata.find(i => i.Name === 'Amount')?.Value;
    const mpesaReceipt = metadata.find(i => i.Name === 'MpesaReceiptNumber')?.Value;
    const phone = metadata.find(i => i.Name === 'PhoneNumber')?.Value;

    // Save to Supabase
    await supabase.from('payments').insert([{
      phone_number: phone,
      amount: amount,
      mpesa_receipt: mpesaReceipt,
      status: 'success'
    }]);
  }
  
  res.json({ ResultCode: 0, ResultDesc: "Accepted" });
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
