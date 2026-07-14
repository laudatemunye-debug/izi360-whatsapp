require('dotenv').config()
const express = require('express')
const qrcode = require('qrcode-terminal')
const pino = require('pino')
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys')

const PORT = process.env.PORT || 3001
const SECRET = process.env.WHATSAPP_SECRET || 'change-me'

const app = express()
app.use(express.json())

let sock = null
let isReady = false

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_session')

  sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      console.log('\n=== SCANNEZ CE QR CODE AVEC LE NUMERO DEDIE ===\n')
      qrcode.generate(qr, { small: true })
    }

    if (connection === 'close') {
      isReady = false
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
      console.log('Connexion fermee. Reconnexion:', shouldReconnect)
      if (shouldReconnect) startSock()
    } else if (connection === 'open') {
      isReady = true
      console.log('✅ Connecte a WhatsApp')
    }
  })
}

function checkSecret(req, res, next) {
  const auth = req.headers.authorization || ''
  if (auth !== `Bearer ${SECRET}`) return res.status(401).json({ message: 'Non autorise' })
  next()
}

app.get('/status', (req, res) => {
  res.json({ ready: isReady })
})

app.post('/send', checkSecret, async (req, res) => {
  if (!isReady) return res.status(503).json({ message: 'WhatsApp non connecte' })

  const { telephone, message } = req.body
  if (!telephone || !message) return res.status(400).json({ message: 'telephone et message requis' })

  try {
    const numero = telephone.replace(/[^0-9]/g, '')
    const jid = `${numero}@s.whatsapp.net`
    await sock.sendMessage(jid, { text: message })
    res.json({ success: true })
  } catch (err) {
    console.error('Erreur envoi:', err)
    res.status(500).json({ message: 'Erreur envoi', error: err.message })
  }
})

app.listen(PORT, () => {
  console.log(`Service WhatsApp demarre sur le port ${PORT}`)
  startSock()
})
