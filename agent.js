const axios = require('axios')

// Memoire de conversation en RAM : phone -> { history: [], transferred: bool, contexte: object|null }
const conversations = new Map()

const MAX_HISTORY = 30 // nombre de messages gardes (user + assistant confondus)

async function resumerEchangesAnciens(messagesAResumer, resumePrecedent) {
  try {
    const texteEchanges = messagesAResumer.map(m => `${m.role === 'user' ? 'Personne' : 'Assistant'}: ${m.content}`).join('\n')
    const promptResume = `Resume tres brievement (3-5 phrases max) les points importants de cet echange
WhatsApp pour qu'un assistant IA puisse s'en souvenir plus tard (infos personnelles donnees, demandes faites,
sujets abordes). ${resumePrecedent ? `Resume deja existant a completer : "${resumePrecedent}"` : ''}

Echanges a resumer :
${texteEchanges}

Reponds uniquement avec le texte du resume, sans JSON, sans preambule.`

    const res = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'user', content: promptResume }],
        temperature: 0.3,
        max_tokens: 200,
      },
      {
        headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        timeout: 10000,
      }
    )
    return res.data.choices[0].message.content.trim()
  } catch (err) {
    console.error('Erreur resume historique:', err.message)
    return resumePrecedent || ''
  }
}

async function recupererContexte(numero) {
  try {
    const res = await axios.get(
      `${process.env.BACKEND_API_URL}/formations/contexte/${numero}`,
      { headers: { Authorization: `Bearer ${process.env.WHATSAPP_SECRET}` }, timeout: 8000 }
    )
    // Trouve directement par le numero WhatsApp de l'expediteur -> identite fiable d'office
    return { ...res.data, identite_verifiee: true }
  } catch (err) {
    return null // pas de contexte trouve, l'agent repondra de facon generique
  }
}

async function recupererContexteParEmail(email) {
  try {
    const res = await axios.get(
      `${process.env.BACKEND_API_URL}/formations/contexte-email/${encodeURIComponent(email)}`,
      { headers: { Authorization: `Bearer ${process.env.WHATSAPP_SECRET}` }, timeout: 8000 }
    )
    return res.data
  } catch (err) {
    return null
  }
}

const REGEX_EMAIL = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/
const REGEX_TELEPHONE = /(?:\+?\d[\s.-]?){9,14}/

const LIEN_APP = process.env.APP_DOWNLOAD_URL || ''

const AIDE_BEAUTYCRM = `
Connaissances detaillees sur l'application BeautyCRM (utilise-les si la personne pose des questions sur l'app) :

BeautyCRM est une application web (PWA) de GESTION D'ENTREPRISE complete : gestion des clients, des ventes,
du stock, de la facturation et de la comptabilite. Elle convient a tout type de petit commerce ou entreprise
(boutiques, distributeurs, prestataires de services, etc.) - ce n'est pas limite a un secteur en particulier.
Ce n'est PAS une app sur l'App Store ou le Play Store.

Fonctionnalites principales (modules de l'application) :
- Clients : fiche complete par client, historique.
- Contacts : gestion des contacts/prospects.
- Produits : catalogue produits avec suivi du benefice par produit.
- Stock : suivi des quantites en stock, alertes.
- Ventes : creation de ventes avec panier multi-produits, generation de factures.
- Credits : ventes a credit avec versements/paiements echelonnes, suivi des factures a credit et de leur
  historique de paiement.
- Comptabilite : bilan (actif, passif, capitaux propres), suivi financier de l'entreprise.
- Rapports : resume mensuel, top clients par chiffre d'affaires, performance par canal de vente, export PDF.
- Rendez-vous : planification de rendez-vous clients.
- Relances : suivi et relance des clients (paiements en retard, suivi commercial).
- Seminaires : gestion de seminaires/formations organises par l'entreprise.
- Tableau de bord : acces rapide aux fonctions, dernieres ventes, prochains rendez-vous.
- Parametres : devise, informations de facturation, gestion de l'entreprise et des employes, synchronisation
  Google Drive.

Si la personne demande comment telecharger/installer/avoir l'application, donne-lui TOUJOURS ce lien exact
dans ta reponse, mot pour mot : ${LIEN_APP}
Explique ensuite qu'il suffit d'ouvrir ce lien dans le navigateur du telephone, puis de faire
"Ajouter a l'ecran d'accueil" pour l'installer comme une vraie application.
Ne parle JAMAIS de l'App Store, du Play Store, ou de recherche dans un store : ce n'est pas ainsi que
BeautyCRM s'installe.

Il existe un mode Personnel (pour un utilisateur seul) et un mode Entreprise (pour une equipe avec un
administrateur et des employes ayant chacun un acces).

Fonctionnement en ligne/hors-ligne (sois precis, ne dis jamais le contraire) :
- Une connexion internet est necessaire pour telecharger/installer l'application la premiere fois.
- Une fois installee, l'application peut ensuite s'ouvrir et etre consultee meme sans internet.
- MAIS pour que les donnees saisies (ventes, clients, stock...) soient bien enregistrees/sauvegardees, une
  connexion internet est necessaire. Ne dis jamais que tout fonctionne "sans internet" sans nuancer ce point :
  la sauvegarde des donnees necessite internet.

IMPORTANT - proposer le lien de telechargement proactivement :
Si, a N'IMPORTE QUEL MOMENT de la conversation (pas seulement au tout premier message), tu comprends que la
personne n'a probablement pas encore installe l'application (elle pose des questions generales, hesite, ne
semble pas la connaitre), donne-lui le lien de telechargement exact (${LIEN_APP}) sans attendre qu'elle te
le demande explicitement.

IMPORTANT - reste concret, jamais vague ou repetitif :
Si la personne dit qu'elle n'est pas commerçante ou ne voit pas l'utilite, ne te contente jamais de repeter
la meme phrase generique ("gestion d'entreprise, clients, ventes...") de facons differentes. Donne des
EXEMPLES CONCRETS adaptes a ce qu'elle pourrait faire : par exemple suivre les personnes qu'elle contacte
regulierement (contacts), noter qui lui doit de l'argent ou ce qu'elle pret (credits), garder une trace de ses
depenses personnelles (comptabilite), planifier des rendez-vous (rdvs). Adapte les exemples a son contexte
si tu le connais (domaine d'activite, etc.), sinon donne 2-3 exemples varies et concrets. Si apres 2-3 echanges
la personne semble toujours perdue ou insatisfaite de tes reponses, propose de la transferer a un humain plutot
que de tourner en rond.

En cas de souci de connexion, de facturation, ou de fonctionnalite bloquee que tu ne peux pas resoudre avec
les informations ci-dessus, propose de transferer a un humain.`

const SCRIPT_PREMIER_CONTACT = (lienApp) => `

SCRIPT DE PREMIER CONTACT (a appliquer seulement si c'est le tout premier message de cette conversation) :
Commence TOUJOURS par te presenter brievement et de facon specifique (jamais generique) : dis que tu es
l'assistant automatique d'IZI360/BeautyCRM, mentionne le sujet precis pour lequel tu es contactee si tu le
connais (nom de la formation par exemple), et dis en une phrase ce que tu peux faire pour la personne
(repondre a ses questions, l'aider a demarrer). Puis, dans la meme reponse ou juste apres, demande a la
personne si elle a deja installe/telecharge l'application BeautyCRM.
- Si elle dit OUI (deja installee) : demande-lui son nom et son email pour confirmer son identite.
- Si elle dit NON (pas encore installee) : donne-lui immediatement le lien exact (${lienApp}) et explique
  comment l'installer (ouvrir le lien, puis "Ajouter a l'ecran d'accueil").
Une fois cette question posee et traitee, continue normalement la conversation pour repondre a ses besoins.`

const SCRIPT_PREMIER_CONTACT_FACEBOOK = (lienApp) => `

SCRIPT DE PREMIER CONTACT (cette personne vient du bouton "Envoyer un message" de la page Facebook/Instagram) :
Commence TOUJOURS par te presenter brievement et de facon specifique (jamais generique) : dis que tu es
l'assistant automatique d'IZI360/BeautyCRM et dis en une phrase ce que tu peux faire pour la personne.
Ne demande PAS d'entree de jeu si elle a installe l'application. A la place, demande-lui poliment ce qu'elle
souhaite savoir ou ce qui l'interesse. Une fois qu'elle a precise sa demande, si c'est pertinent, donne-lui le
lien exact de telechargement de l'application (${lienApp}) en expliquant comment l'installer (ouvrir le lien,
puis "Ajouter a l'ecran d'accueil"). Continue ensuite normalement la conversation.`

function construirePromptSysteme(contexte, estPremierContact, viensDeFacebook, resumeAnterieur) {
  const corps = construirePromptSystemeBase(contexte, estPremierContact, viensDeFacebook)
  if (!resumeAnterieur) return corps
  return `Resume des echanges precedents avec cette personne (au-dela de ce dont tu te souviens directement) :
"${resumeAnterieur}"

${corps}`
}

function construirePromptSystemeBase(contexte, estPremierContact, viensDeFacebook) {
  const inscription = contexte?.inscription_formation
  const utilisateur = contexte?.utilisateur_beautycrm
  const modeEntreprise = contexte?.mode_entreprise

  if (!inscription && !utilisateur) {
    return `Tu es l'assistant WhatsApp d'IZI360 / BeautyCRM. Tu ne trouves aucune inscription ni compte lies a ce numero.
Sois bref, poli, en francais.

IMPORTANT : regarde attentivement l'historique de la conversation ci-dessous avant de repondre.
- Si la personne n'a PAS ENCORE donne son nom ou son email dans les messages precedents, demande-le UNE SEULE
  FOIS, poliment, dans ta prochaine reponse.
- Si elle a DEJA donne son nom et/ou son email a un moment de la conversation (meme il y a plusieurs messages),
  NE LES REDEMANDE JAMAIS. Utilise ce que tu sais deja et continue naturellement la conversation, en repondant
  a sa demande actuelle.
- Ne redemande jamais une information deja donnee, quelle qu'elle soit.

Reponds a ses questions generales sur BeautyCRM avec les connaissances ci-dessous.
${AIDE_BEAUTYCRM}
${estPremierContact ? (viensDeFacebook ? SCRIPT_PREMIER_CONTACT_FACEBOOK(LIEN_APP) : SCRIPT_PREMIER_CONTACT(LIEN_APP)) : ''}

TRANSFERT VERS UN HUMAIN - PROCESSUS EN DEUX TEMPS (ne transfere jamais directement au premier signal) :
- Si la personne demande explicitement a parler a quelqu'un/un humain/un conseiller pour la PREMIERE fois,
  NE transfere PAS tout de suite. Reponds en lui demandant confirmation, par exemple : "Voulez-vous que je
  vous mette en contact avec quelqu'un de l'equipe ?". Mets "transfert": "propose" dans ce cas.
- Si tu lui as DEJA pose cette question de confirmation dans un message precedent (regarde l'historique) ET
  qu'elle confirme maintenant (oui, d'accord, s'il te plait, etc.), mets "transfert": "confirme".
- Dans tous les autres cas, mets "transfert": "non".
Reponds TOUJOURS en JSON strict de cette forme, sans aucun texte autour :
{"reponse": "ton message ici", "transfert": "non" ou "propose" ou "confirme"}`
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
    const identiteVerifiee = contexte?.identite_verifiee === true

    if (!identiteVerifiee) {
      blocCompte = `
Un compte BeautyCRM existe pour l'email/nom mentionne, MAIS le numero WhatsApp qui ecrit ne correspond PAS
au numero enregistre pour ce compte. IDENTITE NON VERIFIEE.
- Tu peux confirmer poliment le PRENOM ${utilisateur.nom ? `(indice: commence par "${utilisateur.nom[0]}")` : ''}
  si la personne te le redemande, mais NE REVELE JAMAIS le nom complet, le nom de l'entreprise, la devise,
  le code de parrainage, ou le statut entreprise/employe tant que l'identite n'est pas confirmee autrement
  (par exemple si elle connait deja ces details elle-meme).
- Si la personne insiste pour obtenir des informations sensibles sur ce compte, transfere a un humain plutot
  que de les donner toi-meme.`
    } else {
      let statutTexte = 'non determine'
      if (modeEntreprise?.statut === 'administrateur') {
        statutTexte = `Administrateur d'entreprise${modeEntreprise.entreprise_fermee ? ' (compte entreprise FERME - a signaler si pertinent)' : ''}`
      } else if (modeEntreprise?.statut === 'employe') {
        statutTexte = `Employe (poste: ${modeEntreprise.poste || 'non precise'})${modeEntreprise.acces_revoque ? ' - ACCES REVOQUE, orienter vers son administrateur ou transferer' : ''}`
      } else if (modeEntreprise?.statut === 'personnel') {
        statutTexte = 'Utilisateur en mode personnel'
      }
      blocCompte = `
Cette personne a deja un compte BeautyCRM (identite verifiee via son numero WhatsApp) :
- Nom : ${utilisateur.nom}
- Version : ${utilisateur.version || 'non precisee'}
- Statut : ${statutTexte}`
    }
  }

  return `Tu es l'assistant WhatsApp d'IZI360 / BeautyCRM.
${blocFormation}
${blocCompte}
${AIDE_BEAUTYCRM}
${estPremierContact ? (viensDeFacebook ? SCRIPT_PREMIER_CONTACT_FACEBOOK(LIEN_APP) : SCRIPT_PREMIER_CONTACT(LIEN_APP)) : ''}

Ton role : reponds a ses questions (formation et/ou app BeautyCRM), aide-la a se sentir accompagnee, guide-la
pour telecharger/utiliser l'app si besoin, et pose des questions pertinentes pour mieux la qualifier si
l'occasion se presente naturellement. Reste bref (2-4 phrases), chaleureux, en francais.
Regarde l'historique de la conversation avant de repondre : ne redemande jamais une information deja donnee.

TRANSFERT VERS UN HUMAIN - PROCESSUS EN DEUX TEMPS (ne transfere jamais directement au premier signal) :
- Si la personne demande EXPLICITEMENT a parler a quelqu'un, un humain, un conseiller, un responsable (ou dit
  qu'elle veut qu'on l'appelle/la contacte directement) pour la PREMIERE fois, ou si son acces est revoque ou
  son entreprise fermee et qu'elle a besoin d'aide que tu ne peux pas resoudre seul : NE transfere PAS tout de
  suite. Reponds en demandant confirmation, par exemple : "Voulez-vous que je vous mette en contact avec
  quelqu'un de l'equipe ?". Mets "transfert": "propose" dans ce cas.
- Si tu lui as DEJA pose cette question de confirmation dans un message precedent (regarde l'historique) ET
  qu'elle confirme maintenant (oui, d'accord, s'il te plait, etc.), mets "transfert": "confirme".
- Dans tous les autres cas, mets "transfert": "non".

Reponds TOUJOURS en JSON strict de cette forme, sans aucun texte autour, sans balises markdown :
{"reponse": "ton message ici", "transfert": "non" ou "propose" ou "confirme"}`
}

function attendre(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function appellerGroqAvecReessai(payload, tentativesMax = 3) {
  for (let tentative = 1; tentative <= tentativesMax; tentative++) {
    try {
      return await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        payload,
        {
          headers: {
            Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        }
      )
    } catch (err) {
      const est429 = err.response?.status === 429
      if (est429 && tentative < tentativesMax) {
        const pause = tentative * 2000 // 2s, puis 4s
        console.log(`Groq 429, nouvelle tentative dans ${pause}ms (essai ${tentative}/${tentativesMax})`)
        await attendre(pause)
        continue
      }
      throw err
    }
  }
}

async function appellerGroq(systemPrompt, historique) {
  const messages = [
    { role: 'system', content: systemPrompt },
    ...historique,
  ]

  const res = await appellerGroqAvecReessai({
    model: 'llama-3.1-8b-instant',
    messages,
    response_format: { type: 'json_object' },
    temperature: 0.4,
    max_tokens: 400,
  })

  const contenu = res.data.choices[0].message.content
  try {
    return JSON.parse(contenu)
  } catch {
    return { reponse: contenu, transfert: 'non' }
  }
}

async function notifierAdmin(sock, numero, contexte, historique, numeroReel) {
  const adminJid = `${process.env.ADMIN_PHONE}@s.whatsapp.net`
  const nom = contexte?.inscription_formation?.nom || contexte?.utilisateur_beautycrm?.nom || 'Inconnu'
  const titreFormation = contexte?.inscription_formation?.titre
  const dernierMsgs = historique.slice(-6).map(m => `${m.role === 'user' ? '👤' : '🤖'} ${m.content}`).join('\n')

  const texte = `🔔 *Transfert demande*

*Prospect :* ${nom}
*Numero :* ${numero}${numeroReel ? ` (vrai numero : ${numeroReel})` : ''}
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

async function gererMessageEntrant(sock, numero, texteRecu, viensDeFacebook = false, numeroReel = null) {
  let conv = conversations.get(numero)

  if (!conv) {
    const contexte = await recupererContexte(numero)
    conv = { history: [], transferred: false, contexte }
    conversations.set(numero, conv)
  }

  // Si deja transfere, l'IA ne repond plus - laisse la main a l'humain
  if (conv.transferred) return null

  const estPremierContact = conv.history.length === 0

  // Si un email est detecte dans le message, on le privilegie pour retrouver le contexte
  // (BeautyCRM identifie les comptes principalement par email, plus fiable que le numero WhatsApp)
  const emailDetecte = texteRecu.match(REGEX_EMAIL)?.[0]
  if (emailDetecte && conv.emailConfirme !== emailDetecte) {
    const contexteParEmail = await recupererContexteParEmail(emailDetecte)
    if (contexteParEmail) {
      // Verification de securite : le numero qui ecrit doit correspondre au numero enregistre
      // pour cet email, sinon on ne revele pas les infos sensibles (entreprise, devise, etc.)
      const numeroEnregistre = (
        contexteParEmail.utilisateur_beautycrm?.telephone ||
        contexteParEmail.inscription_formation?.telephone ||
        ''
      ).replace(/[^0-9]/g, '')
      const numeroActuel = (numeroReel || numero || '').replace(/[^0-9]/g, '')
      const identiteVerifiee = numeroEnregistre && numeroActuel && numeroEnregistre === numeroActuel

      conv.contexte = { ...contexteParEmail, identite_verifiee: identiteVerifiee }
    }
    conv.emailConfirme = emailDetecte
  }

  // Si un numero de telephone est tape dans le texte (ex: "info 243997245614"), meme logique
  // de recherche + verification que pour l'email
  const telephoneDetecte = (texteRecu.match(REGEX_TELEPHONE)?.[0] || '').replace(/[^0-9]/g, '')
  if (telephoneDetecte && telephoneDetecte.length >= 9 && conv.telephoneConfirme !== telephoneDetecte) {
    const contexteParTelephone = await recupererContexte(telephoneDetecte)
    if (contexteParTelephone) {
      const numeroEnregistre = (
        contexteParTelephone.utilisateur_beautycrm?.telephone ||
        contexteParTelephone.inscription_formation?.telephone ||
        ''
      ).replace(/[^0-9]/g, '')
      const numeroActuel = (numeroReel || numero || '').replace(/[^0-9]/g, '')
      const identiteVerifiee = numeroEnregistre && numeroActuel && numeroEnregistre === numeroActuel

      conv.contexte = { ...contexteParTelephone, identite_verifiee: identiteVerifiee }
    }
    conv.telephoneConfirme = telephoneDetecte
  }

  conv.history.push({ role: 'user', content: texteRecu })
  if (conv.history.length > MAX_HISTORY) {
    const nbAEvincer = conv.history.length - MAX_HISTORY
    const messagesAResumer = conv.history.slice(0, nbAEvincer)
    conv.resumeAnterieur = await resumerEchangesAnciens(messagesAResumer, conv.resumeAnterieur)
    conv.history = conv.history.slice(-MAX_HISTORY)
  }

  const systemPrompt = construirePromptSysteme(conv.contexte, estPremierContact, viensDeFacebook, conv.resumeAnterieur)
  let resultat
  try {
    resultat = await appellerGroq(systemPrompt, conv.history)
  } catch (err) {
    console.error('Erreur appel Groq:', err.message)
    return "Desole, j'ai un souci technique en ce moment. Reessaie dans un instant."
  }

  conv.history.push({ role: 'assistant', content: resultat.reponse })

  if (resultat.transfert === 'confirme') {
    conv.transferred = true
    await notifierAdmin(sock, numero, conv.contexte, conv.history, numeroReel)
  }

  return resultat.reponse
}

function reprendreConversation(numero) {
  const conv = conversations.get(numero)
  if (!conv) return false
  conv.transferred = false
  return true
}

module.exports = { gererMessageEntrant, reprendreConversation }
