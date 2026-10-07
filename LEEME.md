# Tablero de Cobranza

Página privada que muestra, con datos en vivo, qué hay que cobrar esta semana, qué venció la semana anterior y qué se cobró en la semana y en el mes.

Es de **solo lectura**: no modifica nada en GoHighLevel ni en las planillas.

## Cómo verla sin configurar nada

Abrí `public/index.html` con doble clic. Al abrirse como archivo, muestra un **modo demo con datos inventados**. Sirve para ver el diseño antes de conectar nada.

## De dónde sale cada número

| Número | Fuente | Regla |
|---|---|---|
| Por cobrar esta semana | Planilla de Mel | Cuotas sin tildar con vencimiento dentro de la semana en curso (sábado a viernes) |
| Vencidas | Planilla de Mel | Cuotas sin tildar con vencimiento en la semana anterior |
| Más antiguas | Planilla de Mel | Cuotas sin tildar anteriores a la semana pasada. No cuenta las de Pausado ni Incobrable, que se muestran aparte |
| Cobrado (semana o mes) | Tu Registro de pagos | Pagos cuya fecha confirmada cae en el período |
| Etapa de cada cliente | Pipeline Cobranza Founders (GHL) | Se cruza con la planilla por email |

Importes en dólares.

## Qué controla la sección "Diferencias"

- **Etapa no coincide:** las cuotas tildadas en la planilla no coinciden con la etapa de la tarjeta. "Cuota 2 Pagada" significa 2 pagadas. "Cuota 3 Pendiente" significa 2 pagadas y la 3 por cobrar.
- **Saldo no coincide:** el valor de la tarjeta debería ser la suma de lo que falta pagar.
- **Pago sin tildar en la planilla:** está en tu Registro pero Mel no lo tildó.
- **Tilde sin pago en tu Registro:** Mel lo tildó pero no está en tu Registro (solo cuotas 2 en adelante).
- **Tarjeta duplicada, sin tarjeta, sin email, sin planilla:** clientes que no se pueden cruzar bien.

## Archivos

- `public/index.html`: la página.
- `netlify/functions/cobranza.mjs`: consulta Google y GHL y arma los datos.
- `netlify/functions/lib/calculo.mjs`: todas las cuentas y cruces.
- `netlify.toml`: configuración de Netlify.

El archivo para Google (`Codigo.gs`) va **aparte**, en la carpeta `para-google`, y **no se sube a GitHub**.

## Variables de entorno en Netlify

Se cargan en Netlify, nunca en el código. Los valores no están en ningún archivo.

| Nombre | Qué es |
|---|---|
| `DASHBOARD_PASSWORD` | Contraseña para entrar al tablero |
| `GHL_TOKEN` | Token de GoHighLevel, solo lectura de oportunidades |
| `APPS_SCRIPT_URL` | Dirección del script de Google ya publicado |
| `APPS_SCRIPT_KEY` | Clave secreta del script de Google |

## Cambiar algo

- La semana empieza el sábado. Para cambiarlo, en `public/index.html` buscá `INICIO_SEMANA`.
- Para actualizar el código, se reemplaza el archivo en GitHub y Netlify republica solo.
