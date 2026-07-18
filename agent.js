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

const AIDE_BEAUTYCRM = `
Connaissances generales sur l'application BeautyCRM (utilise-les si la personne pose des questions sur l'app) :
- BeautyCRM est une application (PWA) pour aider les distributeurs/entrepreneurs beaute (MLM, boutiques, etc.)
  a gerer leurs clients, ventes, stock et facturation.
- Pour telecharger/installer : se rendre sur le lien de l'application (fourni par l'equipe), puis "Ajouter a
  l'ecran d'accueil" depuis le navigateur du telephone.
- Il existe un mode Personnel (pour un utilisateur seul) et un mode Entreprise (pour une equipe avec un
  administrateur et des employes ayant chacun un acces).
- En cas de souci de connexion, de facturation, ou de fonctionnalite bloquee, propose de transferer a un humain
  si tu ne peux pas resoudre avec les informations ci-dessus.`

function construirePromptSysteme(contexte) {
  const inscription = contexte?.inscription_formation
  const utilisateur = contexte?.utilisateur_beautycrm
  const modeEntreprise = contexte?.mode_entreprise

  if (!inscription && !utilisateur) {
    return `Tu es l'assistant WhatsApp d'IZI360 / BeautyCRM. Tu ne trouves aucune inscription ni compte lies a ce numero.
Sois bref, poli, en francais. Demande poliment le nom ou l'email de la personne pour mieux l'aider, ou reponds
a ses questions generales sur BeautyCRM avec les connaissances ci-dessous.
${AIDE_BEAUTYCRM}

Si la personne demande explicitement a parler a quelqu'un/un humain/un conseiller, tu dois le detecter.
Reponds TOUJOURS en JSON strict de cette forme, sans aucun texte autour :
{"reponse": "ton message ici", "transfert": true ou false}`
  }

  let blocFormation = ''
  if (inscription) {
    const dateTexte = inscription.date_debut
      ? new Date(inscription.date_debut).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })
      : 'a confirmer'
    blocFormation = `
Informations de la formation "${inscription.titre}" :
- Description : ${inscription.description || 'non precisee'}
- Date : ${dateTexte}${inscription.heure_debut ? ` a ${inscription.heure_debut}` : ''}
- Lieu : ${inscription.lieu || 'non precise'}
- Duree : ${inscription.duree || 'non precisee'}
- Formateur : ${inscription.formateur || 'non precise'}
- Domaine d'activite du prospect : ${inscription.domaine || 'non precise'}`
  }

  let blocCompte = ''
  if (utilisateur) {
    let statutTexte = 'non determine'
    if (modeEntreprise?.statut === 'administrateur') {
      statutTexte = `Administrateur d'entreprise${modeEntreprise.entreprise_fermee ? ' (compte entreprise FERME - a signaler si pertinent)' : ''}`
    } else if (modeEntreprise?.statut === 'employe') {
      statutTexte = `Employe (poste: ${modeEntreprise.poste || 'non precise'})${modeEntreprise.acces_revoque ? ' - ACCES REVOQUE, orienter vers son administrateur ou transferer' : ''}`
    } else if (modeEntreprise?.statut === 'personnel') {
      statutTexte = 'Utilisateur en mode personnel'
    }
    blocCompte = `
Cette personne a deja un compte BeautyCRM :
- Nom : ${utilisateur.nom}
- Version : ${utilisateur.version || 'non precisee'}
- Statut : ${statutTexte}`
  }

  return `Tu es l'assistant WhatsApp d'IZI360 / BeautyCRM.
${blocFormation}
${blocCompte}
${AIDE_BEAUTYCRM}

Ton role : reponds a ses questions (formation et/ou app BeautyCRM), aide-la a se sentir accompagnee, guide-la
pour telecharger/utiliser l'app si besoin, et pose des questions pertinentes pour mieux la qualifier si
l'occasion se presente naturellement. Reste bref (2-4 phrases), chaleureux, en francais.

Si la personne demande EXPLICITEMENT a parler a quelqu'un, un humain, un conseiller, un responsable, ou dit
qu'elle veut qu'on l'appelle / la contacte directement, tu dois detecter cette intention. Transfere aussi si
son acces est revoque ou son entreprise fermee et qu'elle a besoin d'aide que tu ne peux pas resoudre seul.

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
  const nom = contexte?.inscription_formation?.nom || contexte?.utilisateur_beautycrm?.nom || 'Inconnu'
  const titreFormation = contexte?.inscription_formation?.titre
  const dernierMsgs = historique.slice(-6).map(m => `${m.role === 'user' ? '👤' : '🤖'} ${m.content}`).join('\n')

  const texte = `🔔 *Transfert demande*

*Prospect :* ${nom}
*Numero :* ${numero}
${titreFormation ? `*Formation :* ${titreFormation}\n` : ''}
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
