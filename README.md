# FlowBDD

FlowBDD convierte requerimientos e historias de usuario en una vista previa editable, escenarios BDD y artefactos descargables para QA. La aplicación local permite inspeccionar sitios, revisar selectores y ejecutar recorridos visibles con Chromium.

## Requisitos

- Node.js 18 o superior.
- Python 3.10 o superior para analizar páginas y ejecutar Playwright.
- Playwright de Python y Chromium para análisis/ejecución web. El servidor muestra instrucciones de instalación si no están disponibles.
- OpenAI API key opcional para SuperAgente; la clave se mantiene en memoria en el navegador y se envía directamente a OpenAI junto con el requerimiento cuando se solicita IA. No se guarda en FlowBDD. No pegues secretos de producción.
- Tesseract OCR opcional, instalado en el sistema y disponible en `PATH`. FlowBDD solo presenta texto y coordenadas para inspección manual; no puede convertir OCR en selectores DOM confiables.
- Java opcional para las salidas Java. Los proyectos destino necesitan Selenium WebDriver; la suite también necesita TestNG.
- Appium, sus drivers y un dispositivo configurado son requisitos externos para la salida nativa Escritorio/Móvil. La ejecución Chrome visible es solo para Web.

## Iniciar en Windows

Desde PowerShell, dentro de la carpeta del proyecto:

```powershell
.\iniciar-flowbdd.ps1
```

El script elige un puerto libre entre 4175 y 4200 e imprime la URL exacta para abrir. Para usar otro Python, define la variable antes de iniciar:

```powershell
$env:FLOWBDD_PYTHON = "C:\ruta\al\python.exe"
.\iniciar-flowbdd.ps1
```

## Uso

1. Elegí Solo requerimiento, URL + descripción o modo mixto; seleccioná Web, Escritorio o Móvil.
2. Pegá el flujo y elegí los tipos de prueba y artefactos que querés.
3. Para Web, podés analizar la URL. La detección de controles se realiza con DOM; el OCR opcional agrega una captura y texto aproximado.
4. Si vas a usar IA, activá SuperAgente, pegá una clave temporal y habilitá “Analizar, organizar y sugerir con IA”. El envío a OpenAI solo ocurre al generar la vista previa. Al desactivar SuperAgente, FlowBDD limpia la clave de la memoria de la página.
5. Revisá y editá historia, pasos, selectores, datos, validaciones, escenarios y advertencias.
6. Confirmá para generar las descargas seleccionadas. La sintaxis Python se valida con el Python configurado para el servidor. Java se entrega como plantilla y debe compilarse en el proyecto destino con sus dependencias.
7. Para Web, la ejecución visible opcional abre Chromium, recorre la suite y produce reporte. Las acciones irreversibles requieren intervención/revisión.

## Salidas

- **JSON QA Studio:** especificación versionada, mapa DOM, pasos, datos, recomendaciones, OCR (si está disponible), advertencias, pendientes y Gherkin.
- **Python:** Playwright para Web o Appium para aplicaciones nativas. Es una plantilla revisable; placeholders, selectores ambiguos y casos negativos incompletos se marcan como pendientes/omitidos.
- **Java + Selenium:** clase ejecutable con ChromeDriver y Selenium Manager.
- **Java + TestNG (suite Selenium):** clase de pruebas con ciclo de apertura/cierre del navegador y anotaciones TestNG.

Para un proyecto Maven Java, añadí `org.seleniumhq.selenium:selenium-java`; para la suite, añadí también `org.testng:testng`. Selenium Manager puede resolver ChromeDriver con Selenium 4.6 o superior. FlowBDD no descarga ni instala librerías Java automáticamente.

## Límites conocidos

- “Integración” solo demuestra una integración real cuando se especifican y configuran los servicios involucrados; una prueba de UI no verifica por sí sola API o base de datos.
- Repetir una interfaz en serie no es una prueba de estrés. Para carga concurrente de backend se necesita una herramienta de carga y datos de entorno apropiados.
- Un resultado generado automáticamente es una plantilla QA. Validá los selectores y el comportamiento en el ambiente de pruebas antes de usarlo.
- El acceso a páginas externas depende de su red, autenticación, consentimiento de cookies, protección anti-bot y compatibilidad con automatización.
- El modo SuperAgente usa la API de OpenAI desde el navegador. La clave es visible para el usuario de esa sesión y el contenido solicitado se transmite al proveedor; el uso puede consumir cuota de API.
- Vercel no está configurado en este repositorio. El servicio local usa procesos Python y ejecución de navegador persistente, que requieren adaptar la arquitectura para una plataforma serverless antes de desplegar allí.

## Publicación

El repositorio no contiene configuración de publicación ni credenciales de GitHub/Vercel. Antes de publicar, revisá este README, los artefactos generados y las variables de entorno; no incluyas claves API ni capturas/datos sensibles.


