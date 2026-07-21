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

module.exports = { ajouterLigneConversation }
