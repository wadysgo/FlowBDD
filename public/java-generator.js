function javaString(value) {
  let output = '"';
  for (const character of String(value ?? '')) {
    const code = character.codePointAt(0);
    if (character === '"') output += '\\"';
    else if (character === '\\') output += '\\\\';
    else if (character === '\n') output += '\\n';
    else if (character === '\r') output += '\\r';
    else if (character === '\t') output += '\\t';
    else if (code < 0x20 || code === 0x7f) output += `\\u${code.toString(16).padStart(4, '0')}`;
    else if (code > 0x7e) {
      if (code <= 0xffff) output += `\\u${code.toString(16).padStart(4, '0')}`;
      else {
        const n = code - 0x10000;
        output += `\\u${(0xd800 + (n >> 10)).toString(16)}\\u${(0xdc00 + (n & 0x3ff)).toString(16)}`;
      }
    } else output += character;
  }
  return `${output}"`;
}

function locatorFor(step) {
  const selector = String(step.selector || '');
  const type = String(step.selectorType || '').toLowerCase();
  if (type === 'xpath' || selector.startsWith('//') || selector.startsWith('(')) return `By.xpath(${javaString(selector)})`;
  if (type === 'name') return `By.name(${javaString(selector)})`;
  if (type === 'id') return `By.id(${javaString(selector.replace(/^#/, ''))})`;
  if (type === 'class' || type === 'classname') return `By.className(${javaString(selector.replace(/^\./, ''))})`;
  return `By.cssSelector(${javaString(selector)})`;
}

function stepCode(steps) {
  return steps.map((step, index) => {
    const label = String(step.name || step.description || `Paso ${index + 1}`).replace(/[\r\n]+/g, ' ').replaceAll('*/', '* /');
    const action = String(step.action || 'manual').toLowerCase();
    const selector = step.selector ? locatorFor(step) : '';
    const value = step.value || '';
    const expected = step.expected || '';
    const comment = `        // Paso ${index + 1}: ${label}`;
    if (['navegar', 'goto'].includes(action)) return `${comment}\n        driver.get(${value ? javaString(value) : 'BASE_URL'});`;
    if (['esperar', 'wait'].includes(action)) return `${comment}\n        Thread.sleep(${Math.max(0, Number.parseInt(value, 10) || 1000)}L);`;
    if (action === 'validar_contenido') return `${comment}\n        if (driver.findElement(By.tagName("body")).getText().isBlank()) throw new AssertionError("La página no muestra contenido");`;
    if (!selector) return `${comment}\n        throw new IllegalStateException(${javaString(`Completar selector para: ${label}`)});`;
    const found = `wait.until(ExpectedConditions.presenceOfElementLocated(${selector}))`;
    const visible = `wait.until(ExpectedConditions.visibilityOfElementLocated(${selector}))`;
    if (['desplazar', 'scroll'].includes(action)) return `${comment}\n        WebElement element${index} = ${visible};\n        ((JavascriptExecutor) driver).executeScript("arguments[0].scrollIntoView({block: 'center'});", element${index});`;
    if (['escribir', 'fill', 'completar'].includes(action)) return `${comment}\n        WebElement element${index} = ${visible};\n        element${index}.clear();\n        element${index}.sendKeys(${javaString(value)});`;
    if (action === 'limpiar') return `${comment}\n        ${visible}.clear();`;
    if (['clic', 'click'].includes(action)) return `${comment}\n        wait.until(ExpectedConditions.elementToBeClickable(${selector})).click();`;
    if (action === 'doble_clic') return `${comment}\n        new Actions(driver).doubleClick(${visible}).perform();`;
    if (['presionar_tecla', 'presionar'].includes(action)) return `${comment}\n        ${visible}.sendKeys(${String(value).toLowerCase() === 'enter' ? 'Keys.ENTER' : javaString(value)});`;
    if (['validar', 'verificar', 'assert', 'texto_visible'].includes(action)) {
      const assertion = `if (!${visible}.getText().contains(${javaString(expected)})) throw new AssertionError(${javaString(`No aparece el texto esperado: ${expected}`)});`;
      return `${comment}\n        WebElement element${index} = ${visible};\n        if (!element${index}.isDisplayed()) throw new AssertionError(${javaString(`No está visible: ${label}`)});${expected ? `\n        ${assertion}` : ''}`;
    }
    if (action === 'validar_oculto') return `${comment}\n        if (!driver.findElements(${selector}).isEmpty() && driver.findElement(${selector}).isDisplayed()) throw new AssertionError(${javaString(`Se esperaba elemento oculto: ${label}`)});`;
    if (action === 'validar_conteo') return `${comment}\n        if (driver.findElements(${selector}).size() != ${Math.max(0, Number.parseInt(expected, 10) || 0)}) throw new AssertionError(${javaString(`Cantidad inesperada: ${label}`)});`;
    if (action === 'validar_marcado') return `${comment}\n        if (!${found}.isSelected()) throw new AssertionError(${javaString(`Se esperaba marcado: ${label}`)});`;
    if (action === 'validar_desmarcado') return `${comment}\n        if (${found}.isSelected()) throw new AssertionError(${javaString(`Se esperaba desmarcado: ${label}`)});`;
    return `${comment}\n        throw new IllegalStateException(${javaString(`Acción pendiente de implementar: ${action}`)});`;
  }).join('\n');
}

export function buildJava(data, runner = 'selenium') {
  const isTestNg = runner === 'testng';
  const steps = Array.isArray(data.steps) ? data.steps : [];
  const comments = Array.isArray(data.aiCodeComments) ? data.aiCodeComments : [];
  const flow = stepCode(steps);
  const aiCommentBlock = comments.map(comment => `// Sugerencia QA (revisar): ${String(comment).replace(/[\r\n]+/g, ' ').replaceAll('*/', '* /')}`).join('\n');
  const className = isTestNg ? 'FlowBddGeneratedTest' : 'FlowBddGenerated';
  const groups = (Array.isArray(data.testTypes) && data.testTypes.length ? data.testTypes : ['funcional'])
    .map(type => javaString(type === 'humo' ? 'smoke' : type))
    .join(', ');
  const imports = `import java.time.Duration;\nimport org.openqa.selenium.*;\nimport org.openqa.selenium.chrome.ChromeDriver;\nimport org.openqa.selenium.chrome.ChromeOptions;\nimport org.openqa.selenium.interactions.Actions;\nimport org.openqa.selenium.support.ui.ExpectedConditions;\nimport org.openqa.selenium.support.ui.WebDriverWait;\n${isTestNg ? 'import org.testng.annotations.AfterMethod;\nimport org.testng.annotations.BeforeMethod;\nimport org.testng.annotations.Test;\n' : ''}`;
  const common = `    private static final String BASE_URL = System.getenv().getOrDefault("FLOWBDD_BASE_URL", ${javaString(data.url || '')});\n    private static final int TIMEOUT_SECONDS = Integer.parseInt(System.getenv().getOrDefault("FLOWBDD_TIMEOUT_SECONDS", "20"));\n    private WebDriver driver;\n    private WebDriverWait wait;\n\n    private void iniciarNavegador() {\n        ChromeOptions options = new ChromeOptions();\n        boolean headless = Boolean.parseBoolean(System.getenv().getOrDefault("FLOWBDD_HEADLESS", "false"));\n        if (headless) options.addArguments("--headless=new");\n        options.addArguments("--window-size=1440,1000");\n        driver = new ChromeDriver(options); // Selenium Manager resuelve el driver en Selenium 4.6+\n        wait = new WebDriverWait(driver, Duration.ofSeconds(TIMEOUT_SECONDS));\n    }\n\n    private void ejecutarFlujo() throws InterruptedException {\n${flow}\n    }`;
  const body = isTestNg
    ? `${common}\n\n    @BeforeMethod\n    public void setUp() {\n        iniciarNavegador();\n    }\n\n    @Test(groups = {${groups}}, description = ${javaString(data.title || 'Flujo QA generado por FlowBDD')})\n    public void flujoFuncional() throws InterruptedException {\n        ejecutarFlujo();\n    }\n\n    @AfterMethod(alwaysRun = true)\n    public void tearDown() {\n        if (driver != null) driver.quit();\n    }`
    : `    public static void main(String[] args) throws Exception {\n        FlowBddGenerated test = new FlowBddGenerated();\n        test.iniciarNavegador();\n        try {\n            test.ejecutarFlujo();\n        } finally {\n            if (test.driver != null) test.driver.quit();\n        }\n    }\n\n${common}`;
  return `// FlowBDD | ${String(data.title || 'Prueba QA').replace(/[\r\n]+/g, ' ')}\n// URL: ${String(data.url || 'completar URL').replace(/[\r\n]+/g, ' ')}\n// Java + Selenium${isTestNg ? ' + TestNG (suite)' : ''}\n// Dependencias Maven: org.seleniumhq.selenium:selenium-java${isTestNg ? ' y org.testng:testng' : ''}\n// Revisar selectores, datos, URL y acciones antes de ejecutar.\n${aiCommentBlock}\n${imports}\npublic class ${className} {\n${body}\n}\n`;
}
