const axios = require('axios')

// Memoire de conversation en RAM : phone -> { history: [], transferred: bool, contexte: object|null }
const conversations = new Map()

const MAX_HISTORY = 16 // nombre de messages gardes (user + assistant confondus)

async function recupererContexte(numero) {
  try {
    const res = await axios.get(
      `${process.env.BACKEND_API_URL}/formations/contexte/${numero}`,
      { headers: { Authorization: `Bearer ${process.env.WHATSAPP_SECRET}` }, timeout: 8000 }
    )
    return res.data
  } catch (err) {
    return null // pas de contexte trouve, l'agent repondra de facon generique
  }
}

function construirePromptSysteme(contexte) {
  if (!contexte) {
    return `Tu es l'assistant WhatsApp d'IZI360 / BeautyCRM. Tu ne trouves aucune inscription liee a ce numero.
Sois bref, poli, en francais. Demande poliment de preciser sa question ou son nom pour t'aider.
Si la personne demande explicitement a parler a quelqu'un/un humain/un conseiller, tu dois le detecter.
Reponds TOUJOURS en JSON strict de cette forme, sans aucun texte autour :
{"reponse": "ton message ici", "transfert": true ou false}`
  }

  const dateTexte = contexte.date_debut
    ? new Date(contexte.date_debut).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })
    : 'a confirmer'

  return `Tu es l'assistant WhatsApp d'IZI360 pour la formation "${contexte.titre}".
Informations de la formation :
- Description : ${contexte.description || 'non precisee'}
- Date : ${dateTexte}${contexte.heure_debut ? ` a ${contexte.heure_debut}` : ''}
- Lieu : ${contexte.lieu || 'non precise'}
- Duree : ${contexte.duree || 'non precisee'}
- Formateur : ${contexte.formateur || 'non precise'}

Informations sur le prospect qui t'ecrit :
- Nom : ${contexte.nom}
- Domaine d'activite : ${contexte.domaine || 'non precise'}
- Utilise deja BeautyCRM : ${contexte.utilise_beautycrm || 'non precise'}

Ton role : reponds a ses questions sur la formation, aide-le a se sentir accompagne, et pose des questions
pertinentes pour mieux qualifier son besoin (son activite, ses attentes) si l'occasion se presente naturellement
dans la conversation. Reste bref (2-4 phrases), chaleureux, en francais.

Si la personne demande EXPLICITEMENT a parler a quelqu'un, un humain, un conseiller, un responsable, ou dit
qu'elle veut qu'on l'appelle / la contacte directement, tu dois detecter cette intention.

Reponds TOUJOURS en JSON strict de cette forme, sans aucun texte autour, sans balises markdown :
{"reponse": "ton message ici", "transfert": true ou false}`
}

async function appellerGroq(systemPrompt, historique) {
  const messages = [
    { role: 'system', content: systemPrompt },
    ...historique,
  ]

  const res = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: 'llama-3.3-70b-versatile',
      messages,
      response_format: { type: 'json_object' },
      temperature: 0.4,
      max_tokens: 400,
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    }
  )

  const contenu = res.data.choices[0].message.content
  try {
    return JSON.parse(contenu)
  } catch {
    return { reponse: contenu, transfert: false }
  }
}

async function notifierAdmin(sock, numero, contexte, historique) {
  const adminJid = `${process.env.ADMIN_PHONE}@s.whatsapp.net`
  const nom = contexte?.nom || 'Inconnu'
  const dernierMsgs = historique.slice(-6).map(m => `${m.role === 'user' ? '👤' : '🤖'} ${m.content}`).join('\n')

  const texte = `🔔 *Transfert demande*

*Prospect :* ${nom}
*Numero :* ${numero}
${contexte?.titre ? `*Formation :* ${contexte.titre}\n` : ''}
*Derniers echanges :*
${dernierMsgs}

Le prospect a demande a parler a quelqu'un. Contacte-le directement sur WhatsApp au ${numero}.`

  try {
    await sock.sendMessage(adminJid, { text: texte })
  } catch (err) {
    console.error('Erreur notification admin:', err.message)
  }
}

async function gererMessageEntrant(sock, numero, texteRecu) {
  let conv = conversations.get(numero)

  if (!conv) {
    const contexte = await recupererContexte(numero)
    conv = { history: [], transferred: false, contexte }
    conversations.set(numero, conv)
  }

  // Si deja transfere, l'IA ne repond plus - laisse la main a l'humain
  if (conv.transferred) return null

  conv.history.push({ role: 'user', content: texteRecu })
  if (conv.history.length > MAX_HISTORY) conv.history = conv.history.slice(-MAX_HISTORY)

  const systemPrompt = construirePromptSysteme(conv.contexte)
  let resultat
  try {
    resultat = await appellerGroq(systemPrompt, conv.history)
  } catch (err) {
    console.error('Erreur appel Groq:', err.message)
    return "Desole, j'ai un souci technique en ce moment. Reessaie dans un instant."
  }

  conv.history.push({ role: 'assistant', content: resultat.reponse })

  if (resultat.transfert === true) {
    conv.transferred = true
    await notifierAdmin(sock, numero, conv.contexte, conv.history)
  }

  return resultat.reponse
}

module.exports = { gererMessageEntrant }
