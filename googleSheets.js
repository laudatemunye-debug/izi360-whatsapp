const { google } = require('googleapis')

let sheetsClient = null

function getSheetsClient() {
  if (sheetsClient) return sheetsClient

  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  })

  sheetsClient = google.sheets({ version: 'v4', auth })
  return sheetsClient
}

// Ajoute une ligne : Date | Telephone | Role | Message
async function ajouterLigneConversation(telephone, role, contenu) {
  try {
    const sheets = getSheetsClient()
    const maintenant = new Date().toLocaleString('fr-FR', { timeZone: 'Africa/Lubumbashi' })

    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Feuille 1!A:D',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[maintenant, telephone, role, contenu]],
      },
    })
  } catch (err) {
    console.error('Erreur ecriture Google Sheet:', err.message)
  }
}

// Incremente (ajoute un delta) les stats Groq du jour dans l'onglet "Stats Groq".
// Colonnes : Date | Requetes | TokensPrompt | TokensCompletion | TokensTotal | Erreurs429 | Erreurs413
async function incrementerUsageGroqJournalier(dateStr, delta) {
  try {
    const sheets = getSheetsClient()
    const range = 'Stats Groq!A:G'

    const lecture = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range,
    })
    const lignes = lecture.data.values || []
    const indexLigne = lignes.findIndex(l => l[0] === dateStr)

    if (indexLigne === -1) {
      const nouvelleLigne = [
        dateStr,
        delta.requetes || 0,
        delta.tokensPrompt || 0,
        delta.tokensCompletion || 0,
        delta.tokensTotal || 0,
        delta.erreurs429 || 0,
        delta.erreurs413 || 0,
      ]
      await sheets.spreadsheets.values.append({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: 'Stats Groq!A:G',
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [nouvelleLigne] },
      })
    } else {
      const ligneActuelle = lignes[indexLigne]
      const ligneMaj = [
        dateStr,
        (Number(ligneActuelle[1]) || 0) + (delta.requetes || 0),
        (Number(ligneActuelle[2]) || 0) + (delta.tokensPrompt || 0),
        (Number(ligneActuelle[3]) || 0) + (delta.tokensCompletion || 0),
        (Number(ligneActuelle[4]) || 0) + (delta.tokensTotal || 0),
        (Number(ligneActuelle[5]) || 0) + (delta.erreurs429 || 0),
        (Number(ligneActuelle[6]) || 0) + (delta.erreurs413 || 0),
      ]
      const numeroLigneSheet = indexLigne + 1
      await sheets.spreadsheets.values.update({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: `Stats Groq!A${numeroLigneSheet}:G${numeroLigneSheet}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [ligneMaj] },
      })
    }
  } catch (err) {
    console.error('Erreur ecriture Stats Groq Sheet:', err.message)
  }
}

// Lit les 7 derniers jours de stats Groq depuis l'onglet "Stats Groq"
async function obtenirStatsGroqSemaine() {
  try {
    const sheets = getSheetsClient()
    const lecture = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Stats Groq!A:G',
    })
    const lignes = lecture.data.values || []

    const septJoursAgo = new Date()
    septJoursAgo.setDate(septJoursAgo.getDate() - 7)

    return lignes
      .filter(l => l[0] && new Date(l[0] + 'T00:00:00') >= septJoursAgo)
      .map(l => ({
        date: l[0],
        requetes: Number(l[1]) || 0,
        tokensTotal: Number(l[4]) || 0,
        erreurs429: Number(l[5]) || 0,
        erreurs413: Number(l[6]) || 0,
      }))
      .sort((a, b) => a.date.localeCompare(b.date))
  } catch (err) {
    console.error('Erreur lecture Stats Groq Sheet:', err.message)
    return []
  }
}

module.exports = { ajouterLigneConversation, incrementerUsageGroqJournalier, obtenirStatsGroqSemaine }
