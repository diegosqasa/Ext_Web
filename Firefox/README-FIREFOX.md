# Evidencias para Firefox

Extensión de captura y gestión de evidencias adaptada para Firefox.

## Requisitos

- **Firefox Desktop**: versión 121.0 o superior
- **Firefox Android**: versión 121.0 o superior

## Instalación en Firefox Desktop

### Método 1: Carga temporal (para desarrollo)

1. Abre Firefox y navega a `about:debugging`
2. Selecciona "Este Firefox" en el menú lateral
3. Haz clic en "Cargar complemento temporal..."
4. Navega a la carpeta `Firefox` de esta extensión
5. Selecciona cualquier archivo (ej: `manifest.json`)
6. La extensión se cargará hasta que reinicies Firefox

### Método 2: Instalación permanente (XPI)

1. Empaqueta la extensión:
   ```bash
   cd Firefox
   zip -r ../evidencias-sqa.xpi *
   ```

2. Instala el XPI:
   - Arrastra el archivo `evidencias-sqa.xpi` a Firefox
   - O ve a `about:addons` → engranaje → "Instalar complemento desde archivo..."

## Instalación en Firefox Android

1. Copia el archivo `evidencias-sqa.xpi` a tu dispositivo
2. Abre Firefox para Android
3. Ve a `about:addons` o Configuración → Complementos
4. Toca el engranaje → "Instalar complemento desde archivo"
5. Navega y selecciona el archivo XPI

## Diferencias con la versión de Chrome

| Característica | Chrome | Firefox |
|---------------|--------|---------|
| Background script | `service_worker` | `scripts` (array) |
| Content scripts | Inyectado dinámicamente | Declarativo en manifest |
| ID de extensión | Auto-generado | `evidencias-sqa@sqa.com.co` |
| Versión mínima | Chrome 88+ | Firefox 121+ |

## Estructura de archivos

```
Firefox/
├── manifest.json          # Manifiesto adaptado para Firefox
├── service-worker.js      # Script de background (como módulo)
├── popup.html             # Interfaz del popup
├── popup.js               # Lógica del popup
├── content.js             # Content script
├── offscreen.html         # Página offscreen (si es necesaria)
├── offscreen.js           # Lógica offscreen
├── welcome.html           # Página de bienvenida
├── welcome.js             # Lógica de bienvenida
├── js/
│   └── background/
│       ├── CaptureEngine.js
│       ├── capture-logic.js
│       ├── constants.js
│       ├── state.js
│       └── utils.js
└── Media/                 # Iconos y recursos
    ├── SQA-16.png
    ├── SQA-32.png
    ├── SQA-48.png
    ├── SQA-128.png
    └── ... (más iconos)
```

## Comandos de teclado

| Acción | Windows/Linux | macOS |
|--------|---------------|-------|
| Capturar toda la página | Ctrl+Shift+S | Command+Shift+S |
| Seleccionar área | Ctrl+Shift+E | Command+Shift+E |
| Capturar parte visible | Ctrl+Shift+W | Command+Shift+X |
| Abrir visor de evidencias | Ctrl+Shift+V | Command+Shift+V |

## Permisos requeridos

- `activeTab`: Acceso a la pestaña activa
- `tabs`: Gestión de pestañas
- `scripting`: Inyección de scripts
- `clipboardWrite`: Escritura en portapapeles
- `storage`: Almacenamiento local
- `unlimitedStorage`: Almacenamiento ilimitado
- `offscreen`: Procesamiento en segundo plano
- `debugger`: Captura mediante protocolo debugger
- `<all_urls>`: Acceso a todas las URLs

## Solución de problemas

### La extensión no aparece en about:addons
- Verifica que estás usando Firefox 121 o superior
- Revisa la consola de errores en `about:debugging`

### Error: "Import() is disallowed"
- Este error es esperado y manejado automáticamente
- La extensión usa fallback a content scripts

### Las capturas no funcionan en ciertos sitios
- Algunos sitios tienen políticas CSP estrictas
- Verifica que los permisos estén habilitados

## Notas importantes

1. **Content Scripts**: En Firefox, los content scripts deben declararse explícitamente en el manifiesto (ya incluido).

2. **Background Scripts**: Firefox MV3 soporta tanto `service_worker` como `scripts`. Usamos `scripts` para mejor compatibilidad.

3. **Offscreen Documents**: Firefox tiene soporte limitado para documentos offscreen. La extensión está diseñada para funcionar sin ellos cuando sea necesario.

4. **Debugger API**: Firefox soporta la API debugger pero requiere permisos adicionales en algunos casos.

## Desarrollo

Para desarrollar en Firefox:

1. Usa `about:debugging` para recargar la extensión
2. Revisa la consola del navegador y la consola de la extensión
3. Usa `browser.` en lugar de `chrome.` si necesitas APIs específicas de Firefox

## Publicación en AMO

Para publicar en addons.mozilla.org:

1. Crea una cuenta de desarrollador en https://addons.mozilla.org
2. Empaqueta la extensión como XPI
3. Sube el XPI a AMO
4. Completa la información del complemento
5. Espera la revisión del equipo de AMO

## Licencia

Ver LICENSE en el repositorio principal.

## Soporte

Para reportar problemas específicos de Firefox, abre un issue indicando:
- Versión de Firefox
- Sistema operativo
- Pasos para reproducir
- Capturas de pantalla de la consola de errores
