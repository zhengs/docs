/*
 * Generate the documentation website using the Metalsmith generator.
 *
 * Metalsmith reads all files in the source directory and passes an object of files through a set of plugins.
 * Each key in the files object is a path and the value is an object with many properties.
 * The contents properties has the contents of the file as a Buffer.
 * The frontmatter (stuff between --- at the top of the file) is added as additional properties.
 * When all the plugins are done running, the files object is written to the destination directory.
 * That's it!
 */
'use strict';

var Metalsmith = require('metalsmith');
var markdown = require('metalsmith-markdown');
var templates = require('metalsmith-templates');
var serve = require('metalsmith-serve');
var moveUp = require('metalsmith-move-up');
var less = require('metalsmith-less');
var ignore = require('metalsmith-ignore');
var permalinks = require('metalsmith-permalinks');
var collections = require('metalsmith-collections');
var cleanCSS = require('metalsmith-clean-css');
var compress = require('metalsmith-gzip');
var paths = require('metalsmith-paths');
var partials = require('metalsmith-register-partials');
var helpers = require('metalsmith-register-helpers');
var deviceFeatureFlags = require('./device_feature_flags');
var redirects = require('./redirects');
var copy = require('metalsmith-copy');
var fork = require('./fork');
var inPlace = require('metalsmith-in-place');
var watch = require('metalsmith-watch');
var autotoc = require('metalsmith-autotoc');
var lunr = require('metalsmith-lunr');
var lunr_ = require('lunr');
var fileMetadata = require('metalsmith-filemetadata');
var msIf = require('metalsmith-if');
var precompile = require('./precompile');
var apidoc = require('./apidoc');
var git = require('git-rev');
var path = require('path');

var handlebars = require('handlebars');
var prettify = require('prettify');
prettify.register(handlebars);

//disable autolinking
function noop() {}
noop.exec = noop;
var marked = require('marked');
marked.InlineLexer.rules.gfm.url = noop;

var environment;

var gitBranch;

var generateSearch = process.env.SEARCH_INDEX !== '0';

exports.metalsmith = function() {
  function removeEmptyTokens(token) {
    if (token.length > 0) {
      return token;
    }
  };
  var metalsmith = Metalsmith(__dirname)
    .concurrency(100)
    .source('../src')
    .destination('../build')
    // Convert assets/less/style.less to assets/css/style.css
    // Put new styles in a .less file in assets/less and include it in style.less
    .use(less({
      pattern: '**/less/style.less',
      useDynamicSourceMap: true
    }))
    // Don't copy the styless partials to the build folder
    // Add other patterns of files that should not be copied
    .use(ignore([
      '**/less/*.less',
      'content/languages/**/*',
      'assets/images/**/*.ai'
    ]))
    // Minify CSS
    .use(cleanCSS({
      files: '**/*.css'
    }))
    // Auto-generate documentation from the API using comments formatted in the apidoc format
    .use(
      apidoc({
        destFile: 'content/reference/api.md',
        apis: [
          {
            src: '../api-node/',
            config: '../api-node/',
            includeFilters: ['.*[vV]iews[^.]*\\.js$', 'lib/AccessTokenController.js']
          },
          {
            src: '../api-service-libraries/',
            config: '../api-node/',
            includeFilters: ['.*Controller\\.js$']
          },
        ]
      })
    )
    // Make all files in this directory available to any Handlebar template
    // Use partials like this: {{> arrows}}
    .use(partials({
      directory: '../templates/partials'
    }))
    // Add properties to files that match the pattern
    .use(fileMetadata([
      {pattern: 'content/**/*.md', metadata: {lunr: generateSearch, assets: '/assets', branch: gitBranch}}
    ]))
    .use(msIf(
      environment === 'development',
      fileMetadata([
        {pattern: 'content/**/*.md', metadata: {development: true}}
      ])
    ))
    // Handlebar templates for use in the front-end JS code
    .use(precompile({
      directory: '../templates/precompile',
      dest: 'assets/js/precompiled.js',
      knownHelpers: {
        'each': true,
        'if': true
      }
    }))
    // Move files like contents/reference/firmware.md to reference/firmware.md
    .use(moveUp(['content/**/*']))
    // Add a path key to each file, with sub-keys base, dir, ext, name
    .use(paths())
    // Handlebar helpers to use in any Handlebar template
    // Use helpers like this: {{ reset-button }}
    .use(helpers({
      directory: '../templates/helpers'
    }))
    // Group files into collections and add collection metadata
    // This plugin is complex and buggy.
    // It causes the broken previous / next links when a page doesn't exist for a device
    // It causes the duplicate nav bar bug during development with livereload
    .use(collections({
      guide: {
        pattern: 'guide/:section/*.md',
        sortBy: 'order',
        orderDynamicCollections: [
          'getting-started',
          'tools-and-features',
          'how-to-build-a-product'
        ]
      },
      reference: {
        pattern: 'reference/*md',
        sortBy: 'order',
        orderDynamicCollections: [
          'apis',
          'sdks',
          'dev-tools'
        ]
      },
      tutorials: {
        pattern: 'tutorials/:section/*.md',
        sortBy: 'order',
        orderDynamicCollections: [
          'integrations',
          'dev-tools',
          'projects'
        ]
      },
      faq: {
        pattern: 'faq/:section/*.md',
        sortBy: 'order',
        orderDynamicCollections: [
          'particle-devices',
          'particle-tools',
          'raspberry-pi',
          'wholesale'
        ]
      },
      datasheet: {
        pattern: 'datasheets/*.md',
        sortBy: 'order'
      },
      support: {
        pattern: 'support/:section/*.md',
        sortBy: 'order',
        orderDynamicCollections: [
          'support-and-fulfillment',
          'troubleshooting',
          'inquiries'
        ]
      }
    }))//end of collections/sections
    // Duplicate files that have the devices frontmatter set and make one copy for each device
    // The original file will be replaced by a redirect link
    .use(fork({
      key: 'devices',
      redirectTemplate: './templates/redirector.jade'
    }))
    // For files that have the devices key set, add a bunch of properties like has-wifi, has-cellular
    // Use them in Handlebar templates like this:
    // {{#if has-wifi}}Connect to Wi-Fi{{/if}}
    .use(deviceFeatureFlags({
      config: './device_features.json'
    }))
	// Create HTML pages with meta http-equiv='refresh' redirects
    .use(redirects({
        config: './redirects.json'
    }))
    // Render the Jade templates. This includes the multiple copies of redirector.jade for each device
    // generated by the fork plugin above
    .use(inPlace({
      engine: 'jade',
      pattern: '**/*.jade'
    }))
    // Rename Jade rendered file to HTML
    .use(copy({
      pattern: '**/*.jade',
      extension: '.html',
      move: true
    }))
    // Replace the {{handlebar}} markers inside Markdown files before they are rendered into HTML and
    // any other files with a .hbs extension in the src folder
    .use(inPlace({
      engine: 'handlebars',
      pattern: ['**/*.md', '**/*.hbs']
    }))
	// Remove the .hbs extension from generated files that contained handlebar markers
    .use(copy({
        pattern: '**/*.hbs',
        transform: function removeLastExtension(file) {
			return path.join(path.dirname(file), path.basename(file, path.extname(file)));
		},
        move: true
    }))
	// THIS IS IT!
	// Render the main docs files into HTML
    .use(markdown())
    // Add a toc key for each file based on the HTML header elements in the file
    .use(autotoc({
      selector: 'h2, h3',
      pattern: '**/**/*.md'
    }))
    // Generate Lunr search index for all the files that have lunr: true
    // This is slow. Use SEARCH_INDEX=0 in development to avoid creating this file
    .use(lunr({
      indexPath: 'search-index.json',
      fields: {
          contents: 1,
          title: 10
      },
      pipelineFunctions: [
          removeEmptyTokens
      ]
    }))
    // For files that have a template frontmatter key, look for that template file in the configured directory and
    // render that template using the Metalsmith file with all its keys as context
    .use(templates({
      engine: 'handlebars',
      directory: '../templates'
    }))
    // Rename files so that about.html is converted into about/index.html
    .use(permalinks({
      relative: false
    }));

  return metalsmith;
};

exports.compress = function(callback) {
  Metalsmith(__dirname)
    .clean(false)
    .concurrency(100)
    .source('../build')
    .destination('../build')
    .use(compress({
      src: ['search-index.json'],
      overwrite: true
    }))
    .build(callback);
};

exports.build = function(callback) {
  git.branch(function (str) {
    gitBranch = process.env.TRAVIS_BRANCH || str;
    exports.metalsmith()
      .use(compress({
        src: ['search-index.json'],
        overwrite: true
      }))
      .build(function(err, files) {
        if (err) {
          throw err;
        }
        if (callback) {
          callback(err, files);
        }
      });
  });
};

exports.test = function(callback) {
  var server = serve({ cache: 300 });
  git.branch(function (str) {
    gitBranch = process.env.TRAVIS_BRANCH || str;
    generateSearch = true;
    exports.metalsmith()
      .use(server)
      .build(function(err, files) {
        if (err) {
          console.error(err, err.stack);
        }
        if (callback) {
          callback(err, files);
        }
      });
  });
  return server;
};

exports.server = function(callback) {
  console.time('docs build time');
  environment = 'development';
  git.branch(function (str) {
    gitBranch = process.env.TRAVIS_BRANCH || str;
    exports.metalsmith().use(serve())
      .use(watch({
        paths: {
          '${source}/content/**/*.md': true,
          '${source}/assets/less/*.less': 'assets/less/*.less',
          '../templates/reference.hbs': 'content/reference/*.md',
          '../templates/guide.hbs': 'content/guide/**/*.md',
          '../templates/datasheet.hbs': 'content/datasheets/*.md',
          '../templates/support.hbs': 'content/support/**/*.md',
          '../templates/suppMenu.hbs': 'content/support/**/*.md',
          '${source}/assets/js/*.js*' : true,
          // '../redirects.json': true,
          // '../device_features.json': 'content/**/*.md'
        },
        livereload: true
      }))
      .build(function(err, files) {
        console.timeEnd('docs build time');
        if (err) {
          console.error(err, err.stack);
        }
        if (callback) {
          callback(err, files);
        }
      });
  });
};
