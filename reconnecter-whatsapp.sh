#!/bin/bash
# Script de reconnexion WhatsApp - izi360-whatsapp
# Usage : ./reconnecter-whatsapp.sh
# A placer et lancer depuis ~/izi360-whatsapp

set -e

URL="https://izi360-whatsapp-production.up.railway.app"

echo "=== 1. Verification de l'etat actuel ==="
STATUT=$(curl -s -m 10 "$URL/status" || echo '{"ready":false}')
echo "Statut : $STATUT"

if echo "$STATUT" | grep -q '"ready":true'; then
  echo ""
  echo "✅ WhatsApp est deja connecte. Rien a faire."
  exit 0
fi

echo ""
echo "❌ WhatsApp est deconnecte. Debut de la procedure de reconnexion."
echo ""

echo "=== 2. Nettoyage de la session cassee sur le conteneur ==="
railway ssh "rm -rf /app/auth_session/* && echo 'auth_session vide'"

echo ""
echo "=== 3. Redemarrage du service ==="
railway redeploy

echo ""
echo "=== 4. Affichage des logs en direct ==="
echo "Des que le QR code (dessin en blocs) apparait ci-dessous :"
echo "  -> Ouvre WhatsApp sur le telephone dedie"
echo "  -> Reglages > Appareils lies > Lier un appareil"
echo "  -> Pointe la camera du telephone directement sur cet ecran"
echo "  -> Fais vite, le QR expire en 20-30 secondes"
echo ""
echo "Une ligne 'Stream Errored code 515' suivie de '✅ Connecte a WhatsApp' = succes."
echo "Appuie sur Ctrl+C pour arreter l'affichage une fois connecte."
echo ""
sleep 3
railway logs
