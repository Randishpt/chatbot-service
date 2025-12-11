const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'uploads', 'test.wav');
const form = new FormData();
form.append('audio', fs.createReadStream(filePath));

axios.post('http://localhost:3004/api/transcribe', form, {
    headers: form.getHeaders()
})
    .then(res => {
        console.log('Response:', res.data);
    })
    .catch(err => {
        console.error('Error:', err.response ? err.response.data : err.message);
    });
