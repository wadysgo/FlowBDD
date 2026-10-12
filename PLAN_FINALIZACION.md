# FlowBDD · Lista maestra para cerrar el proyecto

Estado revisado el 12 de octubre de 2026. “Implementado” describe el código presente en el workspace; no implica que se haya desplegado ni que cada aplicación externa haya sido validada.

## Fase 1 · Agente normal

- [x] Modos de entrada: requerimiento, URL + descripción y mixto.
- [x] Plataforma web, escritorio Windows y móvil Android/iOS con plantillas Appium.
- [x] JSON QA Studio, Python + Playwright/Appium y vista previa editable.
- [x] Análisis DOM de controles visibles y mapa de selectores.
- [x] Límite de requerimiento ampliado a 20.000 caracteres.
- [x] Salidas Java + Selenium y Java + TestNG (suite Selenium) para plataforma web.
- [x] Tema oscuro general.
- [ ] Compilación real de Java: no se encontró `javac` ni proyecto Java/Maven para validar las descargas en este equipo.

## Fase 2 · SuperAgente

- [x] Activación, campo temporal de API key, privacidad explícita y toggle de voz.
- [x] Interfaz violeta/azul con tarjetas translúcidas, brillo y título/botón dinámicos.
- [x] Interpretación del requerimiento, escenarios sugeridos, tipos sugeridos, preguntas y comentarios de código.
- [x] Consejos de selector; solo aplica selectores que coincidan con el DOM analizado o con los selectores entregados por el usuario.
- [x] Confirmación antes de transmitir datos sensibles a OpenAI.
- [x] La clave no se guarda en localStorage ni se envía al servidor de FlowBDD; se mantiene en memoria de la pestaña y se transmite directamente a OpenAI cuando se usa IA.
- [x] Mensajes de voz en análisis, resultado y error. La voz es opcional y no activa el micrófono.
- [ ] Prueba real de API: requiere una clave del usuario y su autorización para transmitir el requerimiento al proveedor. No se incluyó una clave en este workspace.

## Fase 3 · Complementos

- [x] Java + Selenium y Java + TestNG (suite Selenium) como descargas distintas.
- [x] OCR opcional basado en CLI Tesseract, con salida de texto/coordenadas marcada para revisión manual.
- [x] Tema oscuro consistente en página, formulario, vista previa y panel de ejecución.
- [ ] OCR real: requiere que Tesseract esté instalado y accesible desde `PATH`; no se instala automáticamente.
- [ ] Prueba en dispositivo móvil/escritorio: requiere aplicación, dispositivo/driver y servidor Appium del entorno destino.

## Fase 4 · Calidad

- [x] `node --check` en los módulos JavaScript.
- [x] `python -m py_compile` en el analizador, runner y script generado con caracteres Unicode.
- [x] Generación en navegador de JSON, Python + Playwright, Java + Selenium y Java + TestNG; Python pasó el validador del servidor.
- [x] Prueba responsive en la ventana de 1191 px: sin desbordamiento horizontal.
- [x] Modo SuperAgente sin API key: la IA queda oculta; al simular una clave de prueba se muestra y al borrarla vuelve a ocultarse; no se realizó ninguna llamada a OpenAI.
- [x] Generación de muestras Java + Selenium y Java + TestNG.
- [x] Prueba visible de extremo a extremo en TodoMVC: recorrido + Humo + Funcional (28 pasos) + Regresión positiva (28 pasos) + Regresión negativa; 5/5 PASS.
- [ ] Validación con API, Tesseract y Java compilador: pendientes de configuración local.

## Fase 5 · Publicación

- [x] `.gitignore` para dependencias, entornos, logs, reportes, capturas, cachés y `.env`.
- [x] `README.md` con instalación, uso, dependencias y límites.
- [ ] GitHub: falta repositorio remoto y autorización/configuración de cuenta.
- [ ] Vercel: falta decidir la adaptación de la ejecución local de Python/Chromium a una arquitectura compatible; no se debe publicar la app tal cual como serverless.
- [ ] LinkedIn: falta grabar la demostración y que el usuario revise y publique el texto.

## Pendientes importantes antes de presentar como “final”

1. Reiniciar FlowBDD desde PowerShell para que el proceso servidor use las correcciones de UTF-8.
2. Instalar/configurar opcionalmente Tesseract, un JDK y Appium en los ambientes donde se usarán esas salidas.
4. Reemplazar cualquier dato real por variables de entorno antes de compartir artefactos.
5. Configurar el destino de publicación y hacer revisión final antes de subir código o publicar material.




