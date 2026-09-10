# Vigilante de Juvenilia Online

Revisa cada 5 minutos que los tres sistemas del colegio estén funcionando y avisa
por WhatsApp cuando algo se rompe — y de nuevo cuando se arregla.

**Qué mira:**

| Chequeo | Qué detecta |
|---|---|
| Portal `juvenilia.online` | El dominio no abre |
| Juvenilia App | La app o su base de datos no responden |
| Juvenilia Gestión | Ídem |
| Juvenilia Chatbot | Ídem |
| Pantalla de ingreso de cada uno | **La pantalla en blanco**: abre pero le faltan archivos de código |
| Caché del portal | El portal volvió a guardar copias viejas (la caída del 10/09/2026) |
| WhatsApp del colegio | Token vencido o reputación del número en rojo |

**Por qué vive acá y no en Railway ni en Vercel:** si el vigilante viviera en el
mismo lugar que lo vigilado, una caída de esa plataforma se llevaría puesto
también al que tiene que avisar. GitHub Actions es un tercer proveedor.

**Por qué el repo es público:** GitHub cobra los minutos de Actions en repos
privados. Correr cada 5 minutos son ~8.600 corridas por mes, muy por encima del
plan gratis. En repos públicos los minutos son ilimitados. Acá **no hay ningún
dato del colegio ni ninguna clave**: solo direcciones que ya son públicas. Las
credenciales viven en *Settings → Secrets* de este repo y nunca se escriben en el
código.

**Los avisos no se repiten:** cuando algo se rompe avisa una vez, y después como
mucho un recordatorio por hora hasta que se arregle.

**Segundo canal, por las dudas:** si algo falla, la corrida queda en rojo y
GitHub manda un mail. Así, si justo el problema es el WhatsApp, el aviso llega igual.

## Configuración

En *Settings → Secrets and variables → Actions*:

| Secreto | Qué es |
|---|---|
| `WA_ACCESS_TOKEN` | Token de Meta (el mismo del Chatbot) |
| `WA_PHONE_NUMBER_ID` | ID del número del colegio en Meta |
| `AVISAR_A` | A quién avisar, en formato internacional sin `+`, separados por coma. Ej: `5492236972540,5492235555555` |

Las plantillas `alerta_sistema` y `alerta_sistema_normalizado` tienen que estar
aprobadas por Meta en el WhatsApp Business del colegio.

## Estado actual

`estado.json` guarda el resultado de la última corrida y desde cuándo está roto
cada chequeo. Es también el historial: el registro de commits de este archivo
muestra todas las caídas.

## Probarlo a mano

Pestaña **Actions → Vigilante → Run workflow**.
