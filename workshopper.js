const argv       = require('optimist').argv
    , fs         = require('fs')
    , path       = require('path')
    , map        = require('map-async')
    , msee       = require('msee')
    , chalk      = require('chalk')

const showMenu         = require('./menu')
    , showLanguageMenu = require('./languageMenu')
    , print            = require('./print-text')
    , util             = require('./util')
    , i18n             = require('./i18n')

const defaultWidth = 65

function Workshopper (options) {
  if (!(this instanceof Workshopper))
    return new Workshopper(options)

  var menuJson
    , handled = false
    , exercise
    , mode = argv._[0]

  if (typeof options != 'object')
    throw new TypeError('need to provide an options object')

  if (typeof options.name != 'string')
    throw new TypeError('need to provide a `name` String option')

  this.appName     = options.name
  this.appDir      = util.assertDir(options, 'appDir')
  this.exerciseDir = util.assertDir(options, 'exerciseDir', options.appDir, 'exercises')
  this.globalDataDir = util.userDir('.config', 'workshopper')
  this.dataDir       = util.userDir('.config', this.appName)

  util.assertFile(options, 'menuJson', options.exerciseDir, 'menu.json')

  this.lang        = "en"
  // optional
  this.menuOptions = options.menu
  // helpFile is additional to the usage in usage.txt
  this.helpFile    = options.helpFile
                            && fs.existsSync(options.helpFile = options.helpFile.replace(/\{lang\}/g, this.lang))
                            && options.helpFile
  // optional
  this.footerFile  = options.footerFile === false
      ? null
      : options.footerFile && fs.existsSync(options.footerFile = options.footerFile.replace(/\{lang\}/g, this.lang))
          ? options.footerFile
          : path.join(__dirname, './footer.' + this.lang + '.md')
  this.width       = typeof options.width == 'number'
      ? options.width
      : defaultWidth
  // an `onComplete` hook function *must* call the callback given to it when it's finished, async or not
  this.onComplete  = typeof options.onComplete == 'function' && options.onComplete
  this.exercises   = require(options.menuJson).filter(function (e) {
    return !/^\/\//.test(e)
  })

  // backwards compatibility
  this.__defineGetter__('title', function () {
    return this.__('title');
  });
  this.__defineGetter__('subtitle', function () {
    return this.__('subtitle');
  });

  this.i18n          = i18n.init(options, this.exercises, this.lang)
  this.__            = this.i18n.__
  this.__n           = this.i18n.__n
  this.languages     = this.i18n.languages

  if (argv.v || argv.version || mode == 'version')
    return console.log(
        this.appName
      + '@'
      + require(path.join(this.appDir, 'package.json')).version
    )

  if (argv.h || argv.help || mode == 'help')
    return this._printHelp()

  this.current = this.getData('current')

  if (options.menuItems && !options.commands)
    options.commands = options.menuItems

  if (Array.isArray(options.commands)) {
    options.commands.forEach(function (item) {
      if (mode == item.name
          || argv[item.name]
          || (item.short && argv[item.short])) {
        handled = true
        return item.handler(this)
      }
    }.bind(this))

    if (handled)
      return

    this.commands = options.commands
  }

  if (mode == 'list') {
    return this.exercises.forEach(function (name) {
      console.log(name)
    })
  }

  if (mode == 'current')
    return console.log(this.current)

  if (mode == 'select' || mode == 'print') {
    return onselect.call(this, argv._.length > 1
      ? argv._.slice(1).join(' ')
      : this.current
    )
  }

  if (mode == 'verify' || mode == 'run') {
    exercise = this.current && this.loadExercise(this.current)

    if (!this.current)
      return error(this.__('error.exercise.none_active'))

    if (!exercise)
      return error(this.__('error.exercise.missing', {name: name}))

    if (exercise.requireSubmission !== false && argv._.length == 1)
      return error(this.__('ui.usage', {appName: this.appName, mode: mode}))

    return this.execute(exercise, mode, argv._.slice(1))
  }

  if (mode == 'reset') {
    this.reset()
    return console.log(this.__('progress.reset', {title: this.__('title')}))
  }

  this.printMenu()
}


Workshopper.prototype.end = function (mode, pass, exercise, callback) {
  exercise.end(mode, pass, function (err) {
    if (err)
      return error(this.__('error.cleanup', {err: err.message || err}))

    setImmediate(callback || function () {
      process.exit(pass ? 0 : -1)
    })
  })
}


// overall exercise fail
Workshopper.prototype.exerciseFail = function (mode, exercise) {
  console.log('\n' + chalk.bold.red('# ' + this.__('solution.fail.title')) + '\n')
  console.log(this.__('solution.fail.message', {name: exercise.name}))

  this.end(mode, false, exercise)
}


// overall exercise pass
Workshopper.prototype.exercisePass = function (mode, exercise) {
  console.log('\n' + chalk.bold.green('# ' + this.__('solution.pass.title')) + '\n')
  console.log(chalk.bold(this.__('solution.pass.message', {name: exercise.name})) + '\n')

  var done = function done () {
    var completed = this.getData('completed') || []
      , remaining

    this.updateData('completed', function (xs) {
      if (!xs)
        xs = []

      return xs.indexOf(exercise.name) >= 0 ? xs : xs.concat(exercise.name)
    })

    completed = this.getData('completed') || []

    remaining = this.exercises.length - completed.length

    if (remaining === 0) {
      if (this.onComplete)
        return this.onComplete(this.end.bind(this, mode, true, exercise))
      else
        console.log(this.__('progress.finished'))
    } else {
      console.log(this.__n('progress.remaining', remaining))
      console.log(this.__('ui.return', {appName: this.appName}))
    }

    this.end(mode, true, exercise)
  }.bind(this)

  if (exercise.hideSolutions)
    return done()

  exercise.getSolutionFiles(function (err, files) {
    if (err)
      return error(this.__('solution.notes.load_error', {err: err.message || err}))
    if (!files.length)
      return done()

    console.log(this.__('solution.notes.compare'))

    function processSolutionFile (file, callback) {
      fs.readFile(file, 'utf8', function (err, content) {
        if (err)
          return callback(err)

        var filename = path.basename(file)

        // code fencing is necessary for msee to render the solution as code
        content = msee.parse('```js\n' + content + '\n```')
        callback(null, { name: filename, content: content })
      })
    }

    function printSolutions (err, solutions) {
      if (err)
        return error(this.__('solution.notes.load_error', {err: err.message || err}))

      solutions.forEach(function (file, i) {
        console.log(chalk.yellow(util.repeat('\u2500', 80)))

        if (solutions.length > 1)
          console.log(chalk.bold.yellow(file.name + ':') + '\n')

        console.log(file.content.replace(/^\n/m, '').replace(/\n$/m, ''))

        if (i == solutions.length - 1)
          console.log(chalk.yellow(util.repeat('\u2500', 80)) + '\n')
      }.bind(this))

      done()
    }

    map(files, processSolutionFile, printSolutions.bind(this))
  }.bind(this))
}


// single 'pass' event for a validation
function onpass (msg) {
  console.log(chalk.green.bold('\u2713 ') + msg)
}


// single 'fail' event for validation
function onfail (msg) {
  console.log(chalk.red.bold('\u2717 ') + msg)
}


Workshopper.prototype.execute = function (exercise, mode, args) {
  // individual validation events
  exercise.on('pass', onpass)
  exercise.on('fail', onfail)

  function done (err, pass) {
    var errback

    if (err) {
      // if there was an error then we need to do this after cleanup
      errback = function () {
        error(this.__('error.exercise.unexpected_error', {mode: mode, err: (err.message || err) }))
      }.bind(this)
    }

    if (mode == 'run' || err)
      return this.end(mode, true, exercise, errback) // clean up

    if (!pass)
      return this.exerciseFail(mode, exercise)

    this.exercisePass(mode, exercise)
  }

  exercise[mode](args, done.bind(this))
}

Workshopper.prototype.selectLanguage = function (lang) {
  this.i18n.changeLang(lang);
  this.lang = lang;
  this.printMenu();
}

Workshopper.prototype.printLanguageMenu = function () {
  var menu = showLanguageMenu({
      name      : this.appName
    , languages : this.i18n.languages
    , lang      : this.lang
    , width     : this.width
    , menu      : this.menuOptions
  }, this.i18n)

  menu.on('select', this.selectLanguage.bind(this))
  menu.on('cancel', this.printMenu.bind(this))
  menu.on('exit', function () {
    console.log()
    process.exit(0)
  })
}

Workshopper.prototype.printMenu = function () {
  var menu = showMenu({
      name          : this.appName
    , languages     : this.i18n.languages
    , width         : this.width
    , completed     : this.getData('completed') || []
    , exercises     : this.exercises
    , extras        : this.commands && this.commands
                        .filter(function (item) {
                          return item.menu !== false
                        })
                        .map(function (item) {
                          return item.name.toLowerCase()
                        })
    , menu          : this.menuOptions
  }, this.i18n)

  menu.on('select', onselect.bind(this))
  menu.on('exit', function () {
    console.log()
    process.exit(0)
  })
  menu.on('language', this.printLanguageMenu.bind(this))
  menu.on('help', function () {
    console.log()
    this._printHelp()
  }.bind(this))

  if (this.commands) {
    this.commands.forEach(function (item) {
      menu.on('extra-' + item.name, function () {
        item.handler(this)
      }.bind(this))
    }.bind(this))
  }
}


Workshopper.prototype.getData = function (name) {
  var file = path.resolve(this.dataDir, name + '.json')
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {}
  return null
}


Workshopper.prototype.updateData = function (id, fn) {
  var json = {}
    , file

  try {
    json = this.getData(id)
  } catch (e) {}

  file = path.resolve(this.dataDir, id + '.json')
  fs.writeFileSync(file, JSON.stringify(fn(json)))
}


Workshopper.prototype.reset = function () {
  fs.unlink(path.resolve(this.dataDir, 'completed.json'))
  fs.unlink(path.resolve(this.dataDir, 'current.json'))
}


Workshopper.prototype.dirFromName = function (name) {
  return util.dirFromName(this.exerciseDir, name)
}


Workshopper.prototype._printHelp = function () {
  this._printUsage()

  if (this.helpFile)
    print.file(this.appName, this.appDir, this.helpFile)
}


Workshopper.prototype._printUsage = function () {
  print.file(this.appName, this.appDir, path.join(__dirname, './usage.' + this.lang + '.txt'))
}

Workshopper.prototype.getExerciseMeta = function (name) {
  name = name.toLowerCase().trim()

  var number
    , dir

  this.exercises.some(function (_name, i) {
    if (_name.toLowerCase().trim() != name)
      return false

    number = i + 1
    name   = _name
    return true
  })

  if (number === undefined)
    return null

  dir = this.dirFromName(name)

  return {
      name         : name
    , number       : number
    , dir          : dir
    , id           : util.idFromName(name)
    , exerciseFile : path.join(dir, './exercise.js')
  }
}

Workshopper.prototype.loadExercise = function (name) {
  var meta = this.getExerciseMeta(name)
    , stat
    , exercise

  if (!meta)
    return null

  try {
    stat = fs.statSync(meta.exerciseFile)
  } catch (err) {
    return error(this.__('error.exercise.missing_file', {exerciseFile: meta.exerciseFile}));
  }

  if (!stat || !stat.isFile())
    return error(this.__('error.exercise.missing_file', {exerciseFile: meta.exerciseFile}));

  exercise = require(meta.exerciseFile)

  if (!exercise || typeof exercise.init != 'function')
    return error(this.__('error.exercise.not_a_workshopper', {exerciseFile: meta.exerciseFile}));

  exercise.init(this, meta.id, meta.name, meta.dir, meta.number)

  return exercise
}

function error () {
  var pr = chalk.bold.red
  console.log(pr.apply(pr, arguments))
  process.exit(-1)
}


function onselect (name) {
  var exercise = this.loadExercise(name)

  if (!exercise)
    return error(__('error.exercise.missing', {name: name}))

  console.log(
      '\n ' + chalk.green.bold(this.__('title'))
    + '\n' + chalk.green.bold(util.repeat('\u2500', chalk.stripColor(this.__('title')).length + 2))
    + '\n ' + chalk.yellow.bold(this.__('exercise.' + exercise.name))
    + '\n ' + chalk.yellow.italic(this.__('progress.state', {count: exercise.number, amount: this.exercises.length}))
    + '\n'
  )

  this.current = exercise.name

  this.updateData('current', function () {
    return exercise.name
  })

  exercise.prepare(function (err) {
    if (err)
      return error(this.__('error.exercise.preparing', {err: err.message || err}))

    exercise.getExerciseText(function (err, type, exerciseText) {
      if (err)
        return error(this.__('error.exercise.loading', {err: err.message || err}))

      print.text(this.appName, this.appDir, type, exerciseText)

      if (this.footerFile)
        print.file(this.appName, this.appDir, this.footerFile)

    }.bind(this))
  }.bind(this))
}


Workshopper.prototype.error = error
Workshopper.prototype.print = print


module.exports = Workshopper
