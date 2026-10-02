// Prints the arguments it was given, as the OS split them (tests/resident-lifetimes.test.js).
process.stdout.write(JSON.stringify(process.argv.slice(2)));
