const axios = require('axios')
const { reprendreConversation } = require('./agent')

const API = process.env.BACKEND_API_URL
const HEADERS = { Authorization: `Bearer ${process.env.WHATSAPP_SECRET}` }
const DELAI_ENTRE_ENVOIS_MS = 12000 // 5 messages par minute max

const sondagesEnAttente = new Map()

const AIDE_TEXTE = `📋 *Commandes disponibles*

/reprendre <numero> - redonne la main a l'IA sur ce numero
/info email <email> - infos sur un compte via son email
/user jour - inscriptions BeautyCRM d'aujourd'hui
/user semaine - inscriptions de la semaine
/user mois - inscriptions du mois
/user total - nombre total d'utilisateurs
/inscrits <nom formation> - liste des inscrits a une formation
/sondage <type> <message> - envoie un sondage a tous les utilisateurs
/resultat sondage - resultats du dernier sondage envoye
/relancer sondage <id> - relance vers ceux qui n'ont pas repondu
/notifier <message> - annonce a tous
/notifier sauf <num1,num2> <message> - annonce a tous sauf ces numeros
/contact <numero> <message> - contacte un numero precis
/contact inscrit jour - message de bienvenue personnalise aux inscrits du jour
/aide - affiche ce message`

function attendre(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function formatDate(d) {
  return new Date(d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })
}

async function estEnAttenteSondage(numero) {
  // Verification en memoire d'abord (rapide), puis en base (survit aux redemarrages)
  if (sondagesEnAttente.has(numero)) return sondagesEnAttente.get(numero)
  try {
    const res = await axios.get(`${API}/formations/admin/sondage-en-attente/${numero}`, { headers: HEADERS, timeout: 8000 })
    return res.data.en_attente ? res.data.sondage_id : null
  } catch (err) {
    console.error('Erreur verification sondage en attente:', err.message)
    return null
  }
}

async function traiterReponseSondage(sock, numero, remoteJid, nom, texteReponse) {
  const sondageId = sondagesEnAttente.get(numero)
  try {
    await axios.post(`${API}/formations/admin/sondage-reponse`, {
      sondage_id: sondageId,
      telephone: numero,
      nom: nom || '',
      reponse: texteReponse,
    }, { headers: HEADERS, timeout: 10000 })
  } catch (err) {
    console.error('Erreur enregistrement reponse sondage:', err.message)
  }
  sondagesEnAttente.delete(numero)
  await sock.sendMessage(remoteJid, { text: `Merci pour votre reponse ! 🙏` })
}

async function genererVariantes(messageBase, nombre = 4) {
  try {
    const prompt = `Genere ${nombre} reformulations differentes du message WhatsApp suivant. Garde EXACTEMENT
le meme sens, les memes informations importantes, et tout lien ou instruction qu'il contient mot pour mot.
Change seulement la formulation/les mots pour que les messages ne se ressemblent pas trop (evite de paraitre
comme un envoi automatise identique a tous). Reste dans le meme ton (poli, francais).

Message original :
"${messageBase}"

Reponds UNIQUEMENT en JSON strict, sans texte autour : {"variantes": ["...", "...", "...", "..."]}`

    const res = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.7,
        max_tokens: 800,
      },
      { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 15000 }
    )
    const data = JSON.parse(res.data.choices[0].message.content)
    if (Array.isArray(data.variantes) && data.variantes.length > 0) return data.variantes
    return [messageBase]
  } catch (err) {
    console.error('Erreur generation variantes:', err.message)
    return [messageBase] // repli : on envoie le message original tel quel a tout le monde
  }
}

async function genererMessageBienvenue(nom) {
  try {
    const prompt = `Genere un message de bienvenue WhatsApp chaleureux en francais pour "${nom}", qui vient de
creer un compte BeautyCRM aujourd'hui. Presente-toi comme l'assistant automatique d'IZI360/BeautyCRM.
Explique tres brievement (2-3 phrases) qu'elle peut gerer ses clients, ventes, stock et facturation dans
l'application. Propose-lui de repondre a ses questions pour bien demarrer. Reste concis (4-5 phrases max),
poli, encourageant. Reponds UNIQUEMENT avec le texte du message, sans guillemets, sans JSON.`

    const res = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        max_tokens: 300,
      },
      { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 15000 }
    )
    return res.data.choices[0].message.content.trim()
  } catch (err) {
    console.error('Erreur generation message bienvenue:', err.message)
    return `Bonjour ${nom} ! 👋 Bienvenue sur BeautyCRM. Je suis l'assistant automatique d'IZI360, dispo pour repondre a vos questions et vous aider a demarrer (gestion clients, ventes, stock, facturation).`
  }
}

async function commandeContactInscritsJour(sock) {
  try {
    const res = await axios.get(`${API}/formations/admin/stats-utilisateurs?periode=jour`, { headers: HEADERS, timeout: 10000 })
    const liste = res.data.liste || []

    if (liste.length === 0) return `Aucune inscription aujourd'hui, rien a envoyer.`

    ;(async () => {
      let succes = 0
      let echecs = 0
      for (const u of liste) {
        const numero = (u.telephone || '').replace(/[^0-9]/g, '')
        if (!numero) continue
        try {
          const messageBienvenue = await genererMessageBienvenue(u.nom)
          await sock.sendMessage(`${numero}@s.whatsapp.net`, { text: messageBienvenue })
          succes++
        } catch (err) {
          console.error(`Erreur contact inscrit ${numero}:`, err.message)
          echecs++
        }
        await attendre(DELAI_ENTRE_ENVOIS_MS)
      }
      console.log(`Contact inscrits du jour termine (${succes} succes, ${echecs} echecs)`)
      try {
        await sock.sendMessage(`${process.env.ADMIN_PHONE}@s.whatsapp.net`, {
          text: `✅ Contact inscrits du jour termine.\n${succes} message(s) envoye(s), ${echecs} echec(s) sur ${liste.length} destinataire(s).`
        })
      } catch (err) {
        console.error('Erreur notification fin contact:', err.message)
      }
    })().catch(err => console.error('Erreur contact inscrits jour en arriere-plan:', err.message))

    const dureeMin = Math.ceil((liste.length * DELAI_ENTRE_ENVOIS_MS) / 60000)
    return `👋 Envoi d'un message de bienvenue personnalise a ${liste.length} inscrit(s) du jour.\nDuree estimee : ~${dureeMin} minutes.`
  } catch (err) {
    return `Erreur : ${err.message}`
  }
}

async function commandeContactNumero(sock, numero, message) {
  const num = numero.replace(/[^0-9]/g, '')
  try {
    await sock.sendMessage(`${num}@s.whatsapp.net`, { text: message })
    return `✅ Message envoye a ${num}.`
  } catch (err) {
    return `Erreur lors de l'envoi a ${num} : ${err.message}`
  }
}

async function envoyerSondageEnArrierePlan(sock, sondageId, variantes, destinataires) {
  const listeVariantes = Array.isArray(variantes) ? variantes : [variantes]
  console.log(`Debut envoi sondage ${sondageId} a ${destinataires.length} destinataires (${listeVariantes.length} variante(s))`)
  let index = 0
  let succes = 0
  let echecs = 0
  for (const dest of destinataires) {
    const numero = (dest.telephone || '').replace(/[^0-9]/g, '')
    if (!numero) continue
    try {
      const texteAEnvoyer = listeVariantes[index % listeVariantes.length]
      await sock.sendMessage(`${numero}@s.whatsapp.net`, { text: texteAEnvoyer })
      sondagesEnAttente.set(numero, sondageId)
      try {
        await axios.post(`${API}/formations/admin/sondage-marquer-envoye`, { sondage_id: sondageId, telephone: numero }, { headers: HEADERS, timeout: 8000 })
      } catch (err) {
        console.error(`Erreur marquage envoye pour ${numero}:`, err.message)
      }
      succes++
    } catch (err) {
      console.error(`Erreur envoi sondage a ${numero}:`, err.message)
      echecs++
    }
    index++
    await attendre(DELAI_ENTRE_ENVOIS_MS)
  }
  console.log(`Sondage ${sondageId} - envoi termine (${succes} succes, ${echecs} echecs)`)
  try {
    await sock.sendMessage(`${process.env.ADMIN_PHONE}@s.whatsapp.net`, {
      text: `✅ Sondage ${sondageId} - envoi termine.\n${succes} message(s) envoye(s) avec succes, ${echecs} echec(s) sur ${destinataires.length} destinataire(s).`
    })
  } catch (err) {
    console.error('Erreur notification fin envoi:', err.message)
  }
}

async function commandeSondage(sock, type, messageBrut) {
  const message = `📊 *Sondage — ${type}*\n\n${messageBrut}\n\n_Repondez directement a ce message._`
  try {
    const res = await axios.post(`${API}/formations/admin/sondage`, { type, message }, { headers: HEADERS, timeout: 15000 })
    const { sondage_id, destinataires } = res.data

    const variantes = await genererVariantes(message)

    envoyerSondageEnArrierePlan(sock, sondage_id, variantes, destinataires).catch(err =>
      console.error('Erreur envoi sondage en arriere-plan:', err.message)
    )

    const dureeMin = Math.ceil((destinataires.length * DELAI_ENTRE_ENVOIS_MS) / 60000)
    return `📊 Sondage "${type}" (id ${sondage_id}) en cours d'envoi a ${destinataires.length} personnes.\nDuree estimee : ~${dureeMin} minutes.\nTape /resultat sondage plus tard pour voir les reponses.`
  } catch (err) {
    return `Erreur lors de la creation du sondage : ${err.message}`
  }
}

async function commandeRelancerSondage(sock, sondageId) {
  try {
    const res = await axios.get(`${API}/formations/admin/sondage-destinataires-restants/${sondageId}`, { headers: HEADERS, timeout: 15000 })
    const { sondage, destinataires } = res.data

    if (destinataires.length === 0) {
      return `Tout le monde a deja repondu au sondage ${sondageId}, rien a relancer.`
    }

    const variantes = await genererVariantes(sondage.message)

    envoyerSondageEnArrierePlan(sock, sondage.id, variantes, destinataires).catch(err =>
      console.error('Erreur relance sondage en arriere-plan:', err.message)
    )

    const dureeMin = Math.ceil((destinataires.length * DELAI_ENTRE_ENVOIS_MS) / 60000)
    return `🔄 Relance du sondage ${sondageId} vers ${destinataires.length} personne(s) n'ayant pas encore repondu.\nDuree estimee : ~${dureeMin} minutes.`
  } catch (err) {
    if (err.response?.status === 404) return `Sondage ${sondageId} introuvable.`
    return `Erreur lors de la relance : ${err.message}`
  }
}

async function envoyerAnnonceEnArrierePlan(sock, variantes, destinataires) {
  console.log(`Debut envoi annonce a ${destinataires.length} destinataires (${variantes.length} variante(s))`)
  let index = 0
  let succes = 0
  let echecs = 0
  for (const dest of destinataires) {
    const numero = (dest.telephone || '').replace(/[^0-9]/g, '')
    if (!numero) continue
    try {
      await sock.sendMessage(`${numero}@s.whatsapp.net`, { text: variantes[index % variantes.length] })
      succes++
    } catch (err) {
      console.error(`Erreur envoi annonce a ${numero}:`, err.message)
      echecs++
    }
    index++
    await attendre(DELAI_ENTRE_ENVOIS_MS)
  }
  console.log(`Annonce - envoi termine (${succes} succes, ${echecs} echecs)`)
  try {
    await sock.sendMessage(`${process.env.ADMIN_PHONE}@s.whatsapp.net`, {
      text: `✅ Annonce - envoi termine.\n${succes} message(s) envoye(s) avec succes, ${echecs} echec(s) sur ${destinataires.length} destinataire(s).`
    })
  } catch (err) {
    console.error('Erreur notification fin envoi:', err.message)
  }
}

async function commandeNotifier(sock, message, exclureListe) {
  try {
    const exclureParam = (exclureListe || []).join(',')
    const res = await axios.get(`${API}/formations/admin/tous-destinataires?exclure=${exclureParam}`, { headers: HEADERS, timeout: 15000 })
    const { destinataires } = res.data

    if (destinataires.length === 0) return `Aucun destinataire trouve.`

    const variantes = await genererVariantes(message)

    envoyerAnnonceEnArrierePlan(sock, variantes, destinataires).catch(err =>
      console.error('Erreur envoi annonce en arriere-plan:', err.message)
    )

    const dureeMin = Math.ceil((destinataires.length * DELAI_ENTRE_ENVOIS_MS) / 60000)
    return `📢 Annonce en cours d'envoi a ${destinataires.length} personne(s)${exclureListe?.length ? ` (${exclureListe.length} exclue(s))` : ''}.\nDuree estimee : ~${dureeMin} minutes.`
  } catch (err) {
    return `Erreur lors de l'envoi de l'annonce : ${err.message}`
  }
}

async function commandeResultatSondage() {
  try {
    const dernierRes = await axios.get(`${API}/formations/admin/sondage-dernier`, { headers: HEADERS, timeout: 10000 })
    const sondage = dernierRes.data

    const resultatRes = await axios.get(`${API}/formations/admin/sondage-resultat/${sondage.id}`, { headers: HEADERS, timeout: 10000 })
    const d = resultatRes.data

    let texte = `📊 *Resultats — ${sondage.type}* (${formatDate(sondage.created_at)})\n${d.nombre_reponses} reponse(s) recue(s)\n\n`
    texte += d.reponses.slice(0, 25).map(r => `• *${r.nom || r.telephone}* : ${r.reponse}`).join('\n')
    if (d.reponses.length > 25) texte += `\n… et ${d.reponses.length - 25} de plus`
    return texte
  } catch (err) {
    if (err.response?.status === 404) return `Aucun sondage trouve.`
    return `Erreur lors de la recherche : ${err.message}`
  }
}

async function commandeInfoEmail(email) {
  try {
    const res = await axios.get(`${API}/formations/contexte-email/${encodeURIComponent(email)}`, { headers: HEADERS, timeout: 10000 })
    const d = res.data
    let texte = `📧 *Infos pour ${email}*\n\n`
    if (d.utilisateur_beautycrm) {
      const u = d.utilisateur_beautycrm
      texte += `*Compte BeautyCRM :*\nNom: ${u.nom}\nTelephone: ${u.telephone}\nEntreprise: ${u.entreprise || '—'}\nVersion: ${u.version || '—'}\nInscrit le: ${formatDate(u.created_at)}\n\n`
    }
    if (d.mode_entreprise) {
      texte += `*Statut :* ${d.mode_entreprise.statut}${d.mode_entreprise.acces_revoque ? ' (ACCES REVOQUE)' : ''}${d.mode_entreprise.entreprise_fermee ? ' (ENTREPRISE FERMEE)' : ''}\n\n`
    }
    if (d.inscription_formation) {
      const i = d.inscription_formation
      texte += `*Inscription formation :*\n${i.titre}\nNom: ${i.nom}\nTelephone: ${i.telephone}`
    }
    return texte
  } catch (err) {
    if (err.response?.status === 404) return `Aucun resultat trouve pour ${email}.`
    return `Erreur lors de la recherche : ${err.message}`
  }
}

async function commandeUserStats(periode) {
  try {
    const res = await axios.get(`${API}/formations/admin/stats-utilisateurs?periode=${periode}`, { headers: HEADERS, timeout: 10000 })
    const d = res.data
    if (periode === 'total') {
      return `👥 *Total utilisateurs BeautyCRM :* ${d.total_utilisateurs}`
    }
    const label = { jour: "aujourd'hui", semaine: 'cette semaine', mois: 'ce mois-ci' }[periode]
    let texte = `👥 *${d.nombre_periode} inscription(s) ${label}* (total: ${d.total_utilisateurs})\n\n`
    texte += d.liste.slice(0, 20).map(u => `• ${u.nom} - ${u.telephone} (${formatDate(u.created_at)})`).join('\n')
    if (d.liste.length > 20) texte += `\n… et ${d.liste.length - 20} de plus`
    return texte
  } catch (err) {
    return `Erreur lors de la recherche : ${err.message}`
  }
}

async function commandeInscritsFormation(recherche) {
  try {
    const res = await axios.get(`${API}/formations/admin/inscrits-formation/${encodeURIComponent(recherche)}`, { headers: HEADERS, timeout: 10000 })
    const d = res.data
    let texte = `🎓 *${d.formation_titre}* - ${d.nombre_inscrits} inscrit(s)\n\n`
    texte += d.inscrits.slice(0, 30).map(i => `• ${i.nom} - ${i.telephone}`).join('\n')
    if (d.inscrits.length > 30) texte += `\n… et ${d.inscrits.length - 30} de plus`
    return texte
  } catch (err) {
    if (err.response?.status === 404) return `Aucune formation trouvee pour "${recherche}".`
    return `Erreur lors de la recherche : ${err.message}`
  }
}

async function traiterCommandeAdmin(texte, sock) {
  const t = texte.trim()

  if (/^\/aide$/i.test(t)) return AIDE_TEXTE

  let m

  m = t.match(/^\/reprendre\s+([\d\s]+)/i)
  if (m) {
    const cible = m[1].replace(/[^0-9]/g, '')
    const ok = reprendreConversation(cible)
    return ok ? `✅ L'IA reprend la conversation avec ${cible}.` : `Aucune conversation active trouvee pour ${cible}.`
  }

  m = t.match(/^\/info\s+(?:email|mail)\s+(\S+)/i)
  if (m) return await commandeInfoEmail(m[1])

  m = t.match(/^\/user\s+(jour|semaine|mois|total)/i)
  if (m) return await commandeUserStats(m[1].toLowerCase())

  m = t.match(/^\/inscrits\s+(.+)/i)
  if (m) return await commandeInscritsFormation(m[1].trim())

  m = t.match(/^\/sondage\s+(\S+)\s+([\s\S]+)/i)
  if (m) return await commandeSondage(sock, m[1], m[2].trim())

  if (/^\/resultat\s+sondage$/i.test(t)) return await commandeResultatSondage()

  m = t.match(/^\/relancer\s+sondage\s+(\d+)/i)
  if (m) return await commandeRelancerSondage(sock, m[1])

  m = t.match(/^\/notifier\s+sauf\s+([\d,\s]+)\s+([\s\S]+)/i)
  if (m) {
    const exclureListe = m[1].split(',').map(n => n.replace(/[^0-9]/g, '')).filter(Boolean)
    return await commandeNotifier(sock, m[2].trim(), exclureListe)
  }

  m = t.match(/^\/notifier\s+([\s\S]+)/i)
  if (m) return await commandeNotifier(sock, m[1].trim(), [])

  if (/^\/contact\s+inscrit\s+jour$/i.test(t)) return await commandeContactInscritsJour(sock)

  m = t.match(/^\/contact\s+(\d[\d\s]*)\s+([\s\S]+)/i)
  if (m) return await commandeContactNumero(sock, m[1], m[2].trim())

  return null
}

module.exports = { traiterCommandeAdmin, estEnAttenteSondage, traiterReponseSondage }
