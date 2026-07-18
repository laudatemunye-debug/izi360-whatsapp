require('dotenv').config()
const express = require('express')
const qrcode = require('qrcode-terminal')
const pino = require('pino')
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys')
const { gererMessageEntrant, reprendreConversation } = require('./agent')

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
      const statusCode = lastDisconnect?.error?.output?.statusCode
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut
      console.log('Connexion fermee. Code:', statusCode, '| Message:', lastDisconnect?.error?.message, '| Reconnexion:', shouldReconnect)
      if (shouldReconnect) startSock()
    } else if (connection === 'open') {
      isReady = true
      console.log('✅ Connecte a WhatsApp')
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    for (const msg of messages) {
      try {
        if (msg.key.fromMe) continue
        if (msg.key.remoteJid?.endsWith('@g.us')) continue // ignore les groupes

        const texte = msg.message?.conversation || msg.message?.extendedTextMessage?.text
        if (!texte) continue

        const numero = msg.key.remoteJid.split('@')[0]

        // Tentative de recuperation du vrai numero WhatsApp meme quand remoteJid est un LID (@lid)
        const numeroReel = (msg.key.senderPn || '').replace(/[^0-9]/g, '') || null

        console.log('DEBUG message recu - remoteJid:', msg.key.remoteJid, '| numero:', numero, '| numeroReel:', numeroReel, '| ADMIN_PHONE:', process.env.ADMIN_PHONE)

        // Commande admin : /reprendre <numero> redonne la main a l'IA sur ce numero
        // (compare au numero LID ET au vrai numero recupere via senderPn)
        if (numero === process.env.ADMIN_PHONE || numeroReel === process.env.ADMIN_PHONE) {
          const match = texte.trim().match(/^\/reprendre\s+([\d\s]+)/i)
          if (match) {
            const cible = match[1].replace(/[^0-9]/g, '')
            const ok = reprendreConversation(cible)
            await sock.sendMessage(msg.key.remoteJid, {
              text: ok ? `✅ L'IA reprend la conversation avec ${cible}.` : `Aucune conversation active trouvee pour ${cible}.`
            })
          }
          continue // les messages de l'admin ne passent jamais par l'agent IA
        }

        // Detection d'un message venant d'un clic sur "Envoyer un message" Facebook/Instagram
        const contextInfo = msg.message?.extendedTextMessage?.contextInfo || msg.message?.conversationExtendedTextMessage?.contextInfo
        const viensDeFacebook = !!(
          contextInfo?.externalAdReplyInfo ||
          contextInfo?.conversionSource ||
          msg.messageStubParameters?.some?.(p => /facebook|instagram|ctwa/i.test(p))
        )

        const reponse = await gererMessageEntrant(sock, numero, texte, viensDeFacebook, numeroReel)
        if (reponse) {
          await sock.sendMessage(msg.key.remoteJid, { text: reponse })
        }
      } catch (err) {
        console.error('Erreur traitement message entrant:', err.message)
      }
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
