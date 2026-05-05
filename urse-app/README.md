# Control URSE — Sistema de seguimiento de autorizaciones

Sistema web local para controlar las URSE autorizadas vs. liquidadas por repartición.

---

## Instalación

### Requisitos
- Node.js 18 o superior (verificar con `node -v`)

### Pasos

```bash
# 1. Entrar a la carpeta del proyecto
cd urse-app

# 2. Instalar dependencias
npm install

# 3. Iniciar el servidor
npm start
```

Abrir el navegador en: **http://localhost:3000**

---

## Acceso inicial

| Usuario | Contraseña | Rol        |
|---------|------------|------------|
| admin   | admin1234  | Administrador |

**⚠ Cambiar la contraseña del admin desde el panel de Usuarios tras el primer ingreso.**

---

## Roles

| Rol        | Puede hacer                                                   |
|------------|---------------------------------------------------------------|
| **Admin**  | Todo: cargar resoluciones, importar archivos, gestionar usuarios |
| **Consulta** | Ver control de saldos, ver liquidaciones y dotación (solo lectura) |

---

## Flujo de uso

### 1. Cargar dotación (una sola vez, o al actualizar)
- Menú **Dotación** → importar el archivo `salida_total_de_agentes.xlsx`
- El sistema toma la repartición más reciente por CUIL automáticamente

### 2. Cargar resoluciones
- Menú **Resoluciones** → completar el formulario
- Cargar **una fila por cada combinación** de:
  - Año + Repartición + Concepto (6183004 ó 6183003)

### 3. Importar liquidaciones
- Menú **Liquidaciones** → importar el Excel de QlikView
- Ítems reconocidos:
  - `CAR_U_URSE_SIM` → concepto 6183004 (días hábiles)
  - `CAR_U_URSE_DIF` → concepto 6183003 (días inhábiles)
- Si hay CUILs sin dotación cargada, quedan marcados como "Sin repartición"

### 4. Ver control de saldos
- Menú **Control de saldos** → cruce automático
- Semáforo:
  - 🟢 Normal — saldo disponible
  - 🟡 Atención — ≥80% consumido
  - 🔴 Excedido — supera el tope autorizado
- Alerta especial si hay liquidaciones de reparticiones **sin resolución** cargada (posible error)

---

## Estructura del proyecto

```
urse-app/
├── data/               # Base de datos SQLite (generada automáticamente)
├── public/
│   ├── login.html      # Pantalla de ingreso
│   └── app.html        # Aplicación principal
├── src/
│   ├── server.js       # Servidor Express (rutas, API)
│   ├── db.js           # Base de datos SQLite (esquema y queries)
│   ├── parser.js       # Parseo de archivos Excel de QlikView
│   └── middleware.js   # Auth y helpers
├── package.json
└── README.md
```

---

## Datos que persisten (base SQLite)
- Usuarios y contraseñas (hasheadas con bcrypt)
- Resoluciones cargadas
- Dotación importada
- Liquidaciones importadas
- Sesiones de usuario

---

## Configuración de puerto

Por defecto corre en el puerto **3000**. Para cambiarlo:

```bash
PORT=8080 npm start
```

---

## Actualización de dotación

Podés reimportar la dotación en cualquier momento. El sistema:
1. Actualiza la repartición de todos los CUILs existentes
2. Re-empareja automáticamente las liquidaciones ya importadas

---

## Soporte de múltiples años

El sistema guarda liquidaciones por año (detectado del encabezado del Excel de QlikView). Podés importar archivos de distintos años y filtrar desde el control de saldos.
