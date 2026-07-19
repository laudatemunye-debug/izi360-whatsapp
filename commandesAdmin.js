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
/aide - affiche ce message`

function attendre(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function formatDate(d) {
  return new Date(d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })
}

function estEnAttenteSondage(numero) {
  return sondagesEnAttente.get(numero) || null
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

async function envoyerSondageEnArrierePlan(sock, sondageId, message, destinataires) {
  console.log(`Debut envoi sondage ${sondageId} a ${destinataires.length} destinataires`)
  for (const dest of destinataires) {
    const numero = (dest.telephone || '').replace(/[^0-9]/g, '')
    if (!numero) continue
    try {
      await sock.sendMessage(`${numero}@s.whatsapp.net`, { text: message })
      sondagesEnAttente.set(numero, sondageId)
    } catch (err) {
      console.error(`Erreur envoi sondage a ${numero}:`, err.message)
    }
    await attendre(DELAI_ENTRE_ENVOIS_MS)
  }
  console.log(`Sondage ${sondageId} - envoi termine`)
}

async function commandeSondage(sock, type, messageBrut) {
  const message = `📊 *Sondage — ${type}*\n\n${messageBrut}\n\n_Repondez directement a ce message._`
  try {
    const res = await axios.post(`${API}/formations/admin/sondage`, { type, message }, { headers: HEADERS, timeout: 15000 })
    const { sondage_id, destinataires } = res.data

    envoyerSondageEnArrierePlan(sock, sondage_id, message, destinataires).catch(err =>
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

    envoyerSondageEnArrierePlan(sock, sondage.id, sondage.message, destinataires).catch(err =>
      console.error('Erreur relance sondage en arriere-plan:', err.message)
    )

    const dureeMin = Math.ceil((destinataires.length * DELAI_ENTRE_ENVOIS_MS) / 60000)
    return `🔄 Relance du sondage ${sondageId} vers ${destinataires.length} personne(s) n'ayant pas encore repondu.\nDuree estimee : ~${dureeMin} minutes.`
  } catch (err) {
    if (err.response?.status === 404) return `Sondage ${sondageId} introuvable.`
    return `Erreur lors de la relance : ${err.message}`
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

  return null
}

module.exports = { traiterCommandeAdmin, estEnAttenteSondage, traiterReponseSondage }
