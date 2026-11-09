/*
 * Headless QUnit runner for the jQuery browser test suite (Chrome via puppeteer-core).
 * Usage: node test/run-qunit-chrome.js <url-to-test/index.html> [module ...]
 * Env: CHROME_BIN = path to the Chrome/Chromium binary.
 *
 * Like the testswarm task (build/tasks/testswarm.js), each module runs in its own page
 * load (index.html?module=NAME). Prints one line per test (PASS/FAIL), every failed
 * assertion, a per-module summary and a grand total, and exits non-zero when any
 * assertion failed or a module stalled.
 */
"use strict";

var puppeteer = require( "puppeteer-core" ),
	baseUrl = process.argv[ 2 ],
	modules = process.argv.slice( 3 ),

	// A module is declared stalled when no test finishes for this long
	// (QUnit.config.testTimeout in test/data/testrunner.js is 20s)
	STALL_MS = 120 * 1000;

if ( !baseUrl ) {
	console.log( "Usage: run-qunit-chrome.js URL [module ...]" );
	process.exit( 2 );
}
if ( !modules.length ) {
	modules = [ null ];
}

function str( v ) {
	try {
		return typeof v === "string" ? v : JSON.stringify( v );
	} catch ( e ) {
		return String( v );
	}
}

function hookQUnit() {
	// Only hook the top-level suite page, not the iframes the tests create
	if ( window.top !== window ) {
		return;
	}
	var tests = 0, failedTests = 0;
	function s( v ) {
		try {
			return typeof v === "string" ? v : JSON.stringify( v );
		} catch ( e ) {
			return String( v );
		}
	}
	document.addEventListener( "DOMContentLoaded", function() {
		if ( !window.QUnit ) {
			return;
		}
		QUnit.log(function( d ) {
			if ( !d.result ) {
				window.__qunitReport({ type: "log", message: d.message || "",
					expected: d.expected === undefined ? undefined : s( d.expected ),
					actual: d.actual === undefined ? undefined : s( d.actual ),
					source: d.source });
			}
		});
		QUnit.testDone(function( d ) {
			tests++;
			if ( d.failed ) {
				failedTests++;
			}
			window.__qunitReport({ type: "testDone", module: d.module, name: d.name,
				failed: d.failed, passed: d.passed, total: d.total });
		});
		QUnit.done(function( d ) {
			window.__qunitReport({ type: "done", tests: tests,
				passedTests: tests - failedTests, failedTests: failedTests,
				total: d.total, passed: d.passed, failed: d.failed, runtime: d.runtime });
		});
	}, false );
}

function runModule( browser, name ) {
	var url = baseUrl + ( name ? ( baseUrl.indexOf( "?" ) < 0 ? "?" : "&" ) +
		"module=" + encodeURIComponent( name ) : "" );

	return browser.newPage().then(function( page ) {
		return new Promise(function( resolve ) {
			var timer,
				settled = false;

			function finish( result ) {
				if ( settled ) {
					return;
				}
				settled = true;
				clearTimeout( timer );
				page.close().then(function() {
					resolve( result );
				}, function() {
					resolve( result );
				});
			}

			function arm() {
				clearTimeout( timer );
				timer = setTimeout(function() {
					console.log( "STALLED: no test finished in " + ( STALL_MS / 1000 ) +
						"s (module " + ( name || "all" ) + ")" );
					finish({ stalled: true });
				}, STALL_MS );
			}

			console.log( "" );
			console.log( "Running " + url );
			arm();

			page.on( "pageerror", function( err ) {
				console.log( "Page error: " + err.message );
			});

			page.exposeFunction( "__qunitReport", function( data ) {
				if ( data.type === "testDone" ) {
					arm();
					console.log( ( data.failed ? "FAIL" : "PASS" ) + " [" + data.module + "] " +
						data.name + " (" + data.passed + "/" + data.total + ")" );
				} else if ( data.type === "log" ) {
					console.log( "    assertion failed: " + data.message +
						( data.expected !== undefined ? " expected: " + str( data.expected ) +
							" actual: " + str( data.actual ) : "" ) +
						( data.source ? "\n      " + data.source.split( "\n" )[ 0 ] : "" ) );
				} else if ( data.type === "done" ) {
					console.log( "Module " + ( name || "all" ) + ": " + data.tests + " tests, " +
						data.passedTests + " passed, " + data.failedTests + " failed; " +
						data.total + " assertions, " + data.failed + " failed (" +
						data.runtime + "ms)" );
					finish( data );
				}
			})
				.then(function() {
					return page.evaluateOnNewDocument( hookQUnit );
				})
				.then(function() {
					return page.goto( url );
				})
				.catch(function( err ) {
					console.log( "Runner error: " + ( err && err.stack || err ) );
					finish({ stalled: true });
				});
		});
	});
}

puppeteer.launch({
	executablePath: process.env.CHROME_BIN || "google-chrome",
	headless: true,
	args: [ "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage" ]
}).then(function( browser ) {
	var totals = { tests: 0, passedTests: 0, failedTests: 0, total: 0, passed: 0, failed: 0 },
		stalled = [];

	return modules.reduce(function( chain, name ) {
		return chain.then(function() {
			return runModule( browser, name ).then(function( r ) {
				if ( r.stalled ) {
					stalled.push( name || "all" );
					return;
				}
				Object.keys( totals ).forEach(function( k ) {
					totals[ k ] += r[ k ];
				});
			});
		});
	}, Promise.resolve() ).then(function() {
		console.log( "" );
		console.log( "Tests completed: " + totals.tests + " tests, " + totals.passedTests +
			" passed, " + totals.failedTests + " failed" );
		console.log( "Assertions: " + totals.total + " total, " + totals.passed +
			" passed, " + totals.failed + " failed" );
		if ( stalled.length ) {
			console.log( "Stalled modules: " + stalled.join( ", " ) );
		}
		return browser.close().then(function() {
			process.exit( totals.failed || stalled.length ? 1 : 0 );
		});
	});
}).catch(function( err ) {
	console.log( "Runner error: " + ( err && err.stack || err ) );
	process.exit( 2 );
});
