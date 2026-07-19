const axios = require('axios')
const { reprendreConversation } = require('./agent')

const API = process.env.BACKEND_API_URL
const HEADERS = { Authorization: `Bearer ${process.env.WHATSAPP_SECRET}` }

const AIDE_TEXTE = `📋 *Commandes disponibles*

/reprendre <numero> - redonne la main a l'IA sur ce numero
/info email <email> - infos sur un compte via son email
/user jour - inscriptions BeautyCRM d'aujourd'hui
/user semaine - inscriptions de la semaine
/user mois - inscriptions du mois
/user total - nombre total d'utilisateurs
/inscrits <nom formation> - liste des inscrits a une formation
/aide - affiche ce message`

function formatDate(d) {
  return new Date(d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })
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

// Retourne le texte de reponse si la commande est reconnue, sinon null (pas une commande admin connue)
async function traiterCommandeAdmin(texte) {
  const t = texte.trim()

  if (/^\/aide$/i.test(t)) return AIDE_TEXTE

  let m

  m = t.match(/^\/reprendre\s+([\d\s]+)/i)
  if (m) {
    const cible = m[1].replace(/[^0-9]/g, '')
    const ok = reprendreConversation(cible)
    return ok ? `✅ L'IA reprend la conversation avec ${cible}.` : `Aucune conversation active trouvee pour ${cible}.`
  }

  m = t.match(/^\/info\s+email\s+(\S+)/i)
  if (m) return await commandeInfoEmail(m[1])

  m = t.match(/^\/user\s+(jour|semaine|mois|total)/i)
  if (m) return await commandeUserStats(m[1].toLowerCase())

  m = t.match(/^\/inscrits\s+(.+)/i)
  if (m) return await commandeInscritsFormation(m[1].trim())

  return null // pas une commande reconnue
}

module.exports = { traiterCommandeAdmin }
