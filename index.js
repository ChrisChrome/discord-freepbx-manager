//Load static files
const config = require("./config.json");
const funcs = require("./funcs.js");
const colors = require("colors");
const embeds = require("./embeds.json")
const axios = require('axios');
const ping = require("ping")
// FreePBX GraphQL Client
const {
	FreepbxGqlClient,
	gql
} = require("freepbx-graphql-client");
const pbxClient = new FreepbxGqlClient(config.freepbx.url, {
	client: {
		id: config.freepbx.clientid,
		secret: config.freepbx.secret,
	}
});

// Set up mariadb connection
const mariadb = require('mariadb');
const pool = mariadb.createPool(config.mariadb);
const cdrPool = mariadb.createPool(config.cdrdb);

// Some functions for FreePBX


const getExtCount = () => {
	return new Promise((resolve, reject) => {
		pbxClient.request(funcs.minifyQuery(funcs.generateQuery('list', {}))).then((result) => {
			resolve(result.fetchAllExtensions.extension.length);
		}).catch((error) => {
			reject(error);
		});
	});
}


const createExtension = (ext, name, uid) => {
	return new Promise((resolve, reject) => {
		pbxClient.request(funcs.minifyQuery(funcs.generateQuery('lookup', {
			ext: ext
		}))).then((result) => {
			// Extension exists
			res = {
				"status": "exists",
			}
			resolve(res);
		}).catch((error) => {
			// Extension does not exist, create it, reload, look it up, and return the result
			pbxClient.request(funcs.minifyQuery(funcs.generateQuery('add', {
				ext: ext,
				name: name,
				uid: uid
			}))).then((result) => {
				pbxClient.request(funcs.minifyQuery(funcs.generateQuery('reload', {
					id: "CreateExt"
				}))).then((result) => {
					pbxClient.request(funcs.minifyQuery(funcs.generateQuery('lookup', {
						ext: ext
					}))).then((result) => {
						res = {
							"status": "created",
							"result": result
						}
						resolve(res);
					}).catch((error) => {
						reject(error);
					});
				}).catch((error) => {
					reject(error);
				});
			}).catch((error) => {
				reject(error);
			});
		});
	});
}

const fixNames = () => { // Gonna leave this here if I ever need it in the future
	pbxClient.request(funcs.minifyQuery(funcs.generateQuery("list", {}))).then((result) => {
		let extensions = result.fetchAllExtensions.extension;
		extensions.forEach((extension) => {
			pbxClient.request(funcs.minifyQuery(funcs.generateQuery("lookup", {
				ext: extension.user.extension
			}))).then((result) => {
				// Get discord user
				dcClient.users.fetch(result.fetchVoiceMail.email).then((user) => {
					// Update extension name
					updateName(extension.user.extension, user.displayName).then((result) => {
						if (result.status == "updated") {
							sendLog(`${colors.green("[INFO]")} Updated extension ${extension.user.extension} name to ${user.displayName}`)
						}
					}).catch((error) => {
						sendLog(`${colors.red("[ERROR]")} ${error}`);
					});
				}).catch((error) => {
					sendLog(`${colors.red("[ERROR]")} ${error}`);
				});
			}).catch((error) => {
				sendLog(`${colors.red("[ERROR]")} ${error}`);
			});
		});
	});
}

// deleteExtension, takes an extension number
const deleteExtension = (ext) => {
	return new Promise(async (resolve, reject) => {
		var conn = await cdrPool.getConnection();
		// delete from cel where cid_num = ext
		const row = await conn.query(`
		DELETE FROM cel
		WHERE cid_num = ${ext}
		`);
		conn.end();
		pbxClient.request(funcs.minifyQuery(funcs.generateQuery('delete', {
			ext: ext
		}))).then((result) => {
			pbxClient.request(funcs.minifyQuery(funcs.generateQuery('reload', {
				id: "DeleteExt"
			}))).then((result) => {
				res = {
					"status": "deleted",
					"result": result
				}
				resolve(res);
			}).catch((error) => {
				reject(error);
			});
		}).catch((error) => {
			reject(error);
		});
	});
}

const updateName = (ext, name) => {
	return new Promise((resolve, reject) => {
		pbxClient.request(funcs.minifyQuery(funcs.generateQuery('lookup', {
			ext: ext
		}))).then((result) => {
			pbxClient.request(funcs.minifyQuery(funcs.generateQuery('update_name', {
				ext: ext,
				name: name
			}))).then((result) => {
				pbxClient.request(funcs.minifyQuery(funcs.generateQuery('reload', {
					id: "UpdateName"
				}))).then((result) => {
					res = {
						"status": "updated",
						"result": result
					}
					resolve(res);
				}).catch((error) => {
					reject(error);
				});
			}).catch((error) => {
				reject(error);
			});
		}).catch((error) => {
			reject(error);
		});
	});
}

const generateExtensionListEmbed = async () => {
	return new Promise(async (resolve, reject) => {
		try {
			var conn = await cdrPool.getConnection();
			const result = await pbxClient.request(funcs.minifyQuery(funcs.generateQuery("list", {})));
			let extensions = result.fetchAllExtensions.extension;
			let extensionList = {};

			// Generate a list of all unique extensions to be checked in the database
			let uniqueExtensions = [...new Set(extensions.map(extension => extension.user.extension))];

			// Construct SQL query to check all unique extensions at the same time
			const row30 = await conn.query(`
			SELECT cid_num, MAX(eventtime) 
			FROM cel 
			WHERE cid_num IN (${uniqueExtensions.join(",")}) 
			AND eventtime >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
			GROUP BY cid_num
			`);

			const row90 = await conn.query(`
			SELECT cid_num, MAX(eventtime) 
			FROM cel 
			WHERE cid_num IN (${uniqueExtensions.join(",")}) 
			AND eventtime >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)
			GROUP BY cid_num
			`);
			// Get fresh/entirely unused extensions
			const alltime = await conn.query(`
			SELECT cid_num
			FROM cel
			WHERE cid_num IN (${uniqueExtensions.join(",")})
			GROUP BY cid_num
			`);
			// turn rows into an array of extension numbers
			let active30 = row30.map(row => row.cid_num);
			let active90 = row90.map(row => row.cid_num);
			let used = alltime.map(row => row.cid_num);


			// Generate inactiveFlag object, if it's a fresh extension set the flag to -

			let inactiveFlag = {};
			uniqueExtensions.forEach((ext) => {
				if (used.includes(ext)) {
					if (active30.includes(ext)) {
						if (active90.includes(ext)) {
							inactiveFlag[ext] = "";
						} else {
							inactiveFlag[ext] = "**";
						}
					} else {
						inactiveFlag[ext] = "*";
					}
				} else {
					inactiveFlag[ext] = "-";
				}
			});

			extensions.forEach((extension) => {
				extensionList[extension.user.extension] = extension.user.name;
			});
			
			// fullList will contain embeds, each embed will contain one field with as many extensions as it can fit (up to 1024 characters). Once the feild is full, make a new embed in the array without a title, just a description. The firrst embed will have a title
			let field = "";
			let embeds = [];
			let count = 0;

			for (let key in extensionList) {
				field += `\`${key}${inactiveFlag[key]}\`: ${extensionList[key]}\n`;
				count++;
				if (field.length >= 1024) {
					embeds.push({
						"color": 0x00ff00,
						"feilds": [
							{
								"name": "Extensions",
								"value": field
							}
						]
					});
					field = "";
				}
			}


			// for (let key in extensionList) {
			// 	extensionList1 += `\`${key}${inactiveFlag[key]}\`: ${extensionList[key]}\n`;
			// }

			//});
			res = embeds;
			// res = {
			// 	"title": "Extension List",
			// 	"color": 0x00ff00,
			// 	"description": `${extensions.length} extensions\n\`* = inactive for 30 days\`\n\`** = inactive for 90 days\`\n\`- = never used\``,
			// 	"fields": [{
			// 		"name": "Extensions",
			// 		"value": `${extensionList1}`
			// 	}],
			// 	"timestamp": new Date()
			// }
			console.log("ending conn debug")
			conn.end();
			resolve(res);
		} catch (error) {
			reject(error);
		}
	});
};

const lookupExtension = (ident, type) => { // type is either "ext" or "uid"
	return new Promise((resolve, reject) => {
		switch (type) {
			case "ext":
				pbxClient.request(funcs.minifyQuery(funcs.generateQuery('lookup', {
					ext: ident
				}))).then((result) => {
					res = {
						"status": "exists",
						"result": result
					}
					resolve(res);
				}).catch((error) => {
					res = {
						"status": "notfound",
						"result": error
					}
					reject(res);
				});
				break;
			case "uid":
				// Find the extension based on Discord ID in the voicemail email field
				pbxClient.request(funcs.minifyQuery(funcs.generateQuery('list', {}))).then(async (result) => {
					// loop through all extensions, run a lookup on each one, and return the first one that matches
					var found = false;
					var ext = "";
					var count = 0;
					result.fetchAllExtensions.extension.forEach(async (ext) => {
						pbxClient.request(funcs.minifyQuery(funcs.generateQuery('lookup', {
							ext: ext.user.extension
						}))).then((result) => {
							if (result.fetchVoiceMail.email == ident && !found) {
								found = true;
								ext = result;
								clearInterval(x);
								resolve({
									"status": "exists",
									"result": ext
								})
							}
							count++;
						}).catch((error) => {
							reject(error);
						});
					});
					x = setInterval(() => {
						if (count == result.fetchAllExtensions.extension.length) {
							clearInterval(x);
							if (!found) {
								reject("Not found");
							}
						}
					}, 100);

				}).catch((error) => {
					reject(error);
				});
				break;
			default:
				reject("Invalid type");
		}
	});
}

const findNextExtension = () => {
	return new Promise((resolve, reject) => {
		pbxClient.request(funcs.minifyQuery(funcs.generateQuery('list', {}))).then((result) => {
			// Find the highest extension
			var highest = 0;
			// output looks like {fetchAllExtensions: { extension: [{user:{extension: 100, name: "Test"}}]}}
			// Look out for gaps in the extension numbers, if there are any, use that one, if not, use the highest + 1
			var exts = [];
			result.fetchAllExtensions.extension.forEach((ext) => {
				exts.push(Number(ext.user.extension));
			});
			exts.sort((a, b) => a - b);
			// Find duplicate extensions and remove all but the first
			for (var i = 0; i < exts.length; i++) {
				if (exts[i] == exts[i + 1]) {
					exts.splice(i, 1);
					i--;
				}
			}



			// Start should be the lowest extension. If none exists use config value
			// Await if statement
			var start = 0;
			if (exts.length > 0) {
				start = exts[0];
			} else {
				start = config.freepbx.startExt;
				exts[0] = start - 1;
			}
			for (var i = 0; i < exts.length; i++) {
				if (exts[i] != i + config.freepbx.startExt) {
					highest = i + start;
					break;
				}
			}
			if (highest == 0) {
				highest = String(Number(exts[exts.length - 1]) + 1);
			}

			// Return the next extension
			res = {
				"status": "success",
				"result": String(highest)
			}
			resolve(res);
		}).catch((error) => {
			reject(error);
		});
	});
}

// Load Discord.js
const Discord = require("discord.js");
const {
	REST,
	Routes
} = require('discord.js');
const dcClient = new Discord.Client({
	intents: ["Guilds", "GuildMembers"]
});
const rest = new REST({
	version: '10'
}).setToken(config.discord.token);
var logChannel;
var sendLog;
var logMsg = null; // Used to store the log message, so it can be edited instead of sending a new one
var curMsg = ""; // Used to calculate the length of the log message, so it can be edited instead of sending a new one
dcClient.on('ready', async () => {
	await dcClient.channels.fetch(config.discord.logId).then(async (channel) => {
		await channel.send(`\`\`\`ansi\n${curMsg}\`\`\``).then((msg) => {
			logMsg = msg;
		});
		sendLog = async (message) => {
			let timestamp = new Date()
			message = `[${timestamp.toLocaleString()}] ${message}`;
			if (curMsg.length + message.length <= 2000) {
				curMsg = `${curMsg}\n${message}`;
				await logMsg.edit(`\`\`\`ansi\n${curMsg}\`\`\``);
			} else {
				curMsg = message;
				await channel.send(`\`\`\`ansi\n${message}\`\`\``).then((msg) => {
					logMsg = msg;
				});
			}
			console.log(message);
		};

		sendLog(`${colors.cyan("[INFO]")} Logged in as ${dcClient.user.displayName}!`);

		const pageGroups = require('./pageGroups.json');
		var commands = [
			{
				"name": "whoami",
				"description": "Get your extension info if you have one",
				"type": 1
			},
			{
				"name": "new",
				"description": "Get an extension on the LiteNet Phone System",
				"type": 1
			},
			{
				"name": "delete",
				"description": "Remove your extension from the LiteNet Phone System",
				"type": 1,
				"options": [
					{
						"name": "confirm",
						"description": "Confirm that you want to delete your extension. THIS CANNOT BE UNDONE!",
						"type": 5,
						"required": true,
						"choices": [
							{
								"name": "yes",
								"value": "yes"
							}
						]
					}
				]
			},
			{
				"name": "list",
				"description": "List all extensions on the LiteNet Phone System",
				"type": 1
			},
			{
				"name": "button",
				"description": "Send the get an extension button!",
				"type": 1,
				"default_member_permissions": 0
			},
			{
				"name": "name",
				"description": "Change your extension's name (Defaults to your Discord name)",
				"type": 1,
				"options": [
					{
						"name": "name",
						"description": "The new name for your extension",
						"type": 3,
						"required": false
					}
				]
			},
			{
				"name": "paging",
				"description": "Add/Remove yourself from paging groups",
				"type": 1,
				"options": [
					{
						"name": "method",
						"description": "The method to use",
						"type": 3,
						"required": true,
						"choices": [
							{
								"name": "add",
								"value": "add"
							},
							{
								"name": "remove",
								"value": "remove"
							}
						]
					},
					{
						"name": "group",
						"description": "The group to add/remove yourself from",
						"type": 3,
						"required": true,
						"choices": pageGroups
					}
				]
			},
			{
				"name": "Lookup Extension",
				"type": 2,
			},
			{
				"name": "Create Extension",
				"type": 2,
				"default_member_permissions": 0
			},
			{
				"name": "Delete Extension",
				"type": 2,
				"default_member_permissions": 0
			}
		];


		(async () => {
			try {
				sendLog(`${colors.cyan("[INFO]")} Started refreshing application (/) commands.`);
				await rest.put(
					Routes.applicationGuildCommands(dcClient.user.id, config.discord.guildId), {
					body: commands
				}
				);
				sendLog(`${colors.cyan("[INFO]")} Successfully reloaded application (/) commands.`);
			} catch (error) {
				console.error(`${colors.red("[ERROR]")} ${error}`);
			}
		})();

		// Presence Stuff
		getExtCount().then((result) => {
			dcClient.user.setPresence({
				activities: [{
					name: `${result} extensions`,
					type: "WATCHING"
				}],
				status: "online"
			});
		}).catch((error) => {
			sendLog(`${colors.red("[ERROR]")} ${error}`);
		});

		// Run every 5 minutes
		setInterval(() => {
			getExtCount().then((result) => {
				dcClient.user.setPresence({
					activities: [{
						name: `${result} extensions`,
						type: "WATCHING"
					}],
					status: "online"
				});
			}).catch((error) => {
				sendLog(`${colors.red("[ERROR]")} ${error}`);
			});
		}, 300000);

		// Lookup all extensions and check if they're still in the server
		// If they're not, delete them
		// Run once on startup
		pbxClient.request(funcs.minifyQuery(funcs.generateQuery("list", {}))).then((result) => {
			let extensions = result.fetchAllExtensions.extension;
			extensions.forEach((extension) => {
				lookupExtension(extension.user.extension, "ext").then((result) => {
					if (result.result.fetchVoiceMail.email == null) {
						// Extension is not part of the bot, do nothing
						return;
					};
					// Fetch Discord user using ID stored in result.result.fetchVoiceMail.email, and see if they're in the server
					dcClient.guilds.cache.get(config.discord.guildId).members.fetch(result.result.fetchVoiceMail.email).then((member) => {
						// They're in the server, do nothing
					}).catch((error) => {
						// They're not in the server, delete the extension
						sendLog(`${colors.cyan("[INFO]")} ${extension.user.extension} is not in the server, deleting it`);
						deleteExtension(extension.user.extension).then((result) => {
							sendLog(`${colors.cyan("[INFO]")} Deleted extension ${extension.user.extension} because the user is no longer in the server`);
						}).catch((error) => {
							sendLog(`${colors.red("[ERROR]")} ${error}`);
						});
					});

				});
			});
		})

		// Run every 5 minutes
		const extListChannel = dcClient.channels.cache.get(config.discord.extList);
		// Find the latest message from the bot in extListChannel, if there isn't one, send one. There can be other messages in the channel
		// Sends the same message as the list command
		setInterval(async () => {
			await extListChannel.messages.fetch({
				limit: 1
			}).then((messages) => {
				if (messages.size == 0) {
					pbxClient.request(funcs.minifyQuery(funcs.generateQuery("list", {}))).then((result) => {
						let extensions = result.fetchAllExtensions.extension;
						// key:value pairs of extension:username
						let extensionList = {};
						extensions.forEach((extension) => {
							extensionList[extension.user.extension] = extension.user.name;
						});
						extensionList1 = "";
						for (let key in extensionList) {
							extensionList1 += `\`${key}\`: ${extensionList[key]}\n`;
						}
						generateExtensionListEmbed().then(embed => {
							extListChannel.send({
								content: "",
								embeds: embed
							});
						})
					})
				} else {
					pbxClient.request(funcs.minifyQuery(funcs.generateQuery("list", {}))).then((result) => {
						let extensions = result.fetchAllExtensions.extension;
						// key:value pairs of extension:username
						let extensionList = {};
						extensions.forEach((extension) => {
							extensionList[extension.user.extension] = extension.user.name;
						});
						extensionList1 = "";
						for (let key in extensionList) {
							extensionList1 += `\`${key}\`: ${extensionList[key]}\n`;
						}
						generateExtensionListEmbed().then(embed => {
							messages.first().edit({
								content: "",
								embeds: embed
							});
						});
					})
				}
			})
		}, 300000);
		// Also run on startup
		extListChannel.messages.fetch({
			limit: 1
		}).then((messages) => {
			if (messages.size == 0) {
				pbxClient.request(funcs.minifyQuery(funcs.generateQuery("list", {}))).then((result) => {
					let extensions = result.fetchAllExtensions.extension;
					// key:value pairs of extension:username
					let extensionList = {};
					extensions.forEach((extension) => {
						extensionList[extension.user.extension] = extension.user.name;
					});
					extensionList1 = "";
					for (let key in extensionList) {
						extensionList1 += `\`${key}\`: ${extensionList[key]}\n`;
					}
					generateExtensionListEmbed().then(embed => {
						extListChannel.send({
							content: "",
							embeds: embed
						});
					});
				})
			} else {
				pbxClient.request(funcs.minifyQuery(funcs.generateQuery("list", {}))).then((result) => {
					let extensions = result.fetchAllExtensions.extension;
					// key:value pairs of extension:username
					let extensionList = {};
					extensions.forEach((extension) => {
						extensionList[extension.user.extension] = extension.user.name;
					});
					extensionList1 = "";
					for (let key in extensionList) {
						extensionList1 += `\`${key}\`: ${extensionList[key]}\n`;
					}
					generateExtensionListEmbed().then(embed => {
						messages.first().edit({
							content: "",
							embeds: embed
						});
					});
				})
			}
		})

	});

	// Uptime Kuma Ping
	// Calculate ping to Discord API

	// Every X seconds (defined in config.status.interval), send a ping to Uptime Kuma, send push request to config.status.url
	setInterval(() => {
		// Send a ping to Uptime Kuma
		// Send a push request to config.status.url
		// Define URL arguments ?status=up&msg=OK&ping=

		// Calculate ping to Discord API
		const start = Date.now();
		axios.get("https://discord.com/api/gateway").then((result) => {
			const latency = Date.now() - start;
			axios.get(config.status.url + `?status=up&msg=OK&ping=${latency}`).then((result) => {
				//sendLog(`${colors.cyan("[INFO]")} Sent ping to Uptime Kuma`);
			}).catch((error) => {
				sendLog(`${colors.red("[ERROR]")} Error sending ping ${error}`);
			});
		})
	}, config.status.interval * 1000);
	const start = Date.now();
	axios.get("https://discord.com/api/gateway").then((result) => {
		const latency = Date.now() - start;
		axios.get(config.status.url + `?status=up&msg=OK&ping=${latency}`).then((result) => {
			//sendLog(`${colors.cyan("[INFO]")} Sent ping to Uptime Kuma`);
		}).catch((error) => {
			sendLog(`${colors.red("[ERROR]")} Error sending ping ${error}`);
		});
	})
});

dcClient.on("guildMemberRemove", (member) => {
	// Delete the extension if the user leaves the server
	sendLog(`${colors.cyan("[INFO]")} User ${member.id} left the server`)
	lookupExtension(member.id, "uid").then((result) => {
		if (result.status == "exists") {
			sendLog(`${colors.cyan("[INFO]")} User ${member.id} has extension ${result.result.fetchExtension.user.extension}, deleting it`)
			deleteExtension(result.result.fetchExtension.user.extension).then((delResult) => {
				sendLog(`${colors.cyan("[INFO]")} Deleted extension ${result.result.fetchExtension.user.extension} because the user left the server`);
			}).catch((error) => {
				sendLog(`${colors.red("[ERROR]")} ${error}`);
			});
		}
	}).catch((error) => {
		sendLog(`${colors.red("[ERROR]")} ${error}`);
	});
});

dcClient.on('interactionCreate', async interaction => {
	if (interaction.isCommand()) {
		const {
			commandName
		} = interaction;
		switch (commandName) {
			case "new":
				await interaction.deferReply({
					ephemeral: true
				});
				lookupExtension(interaction.user.id, "uid").then((result) => {
					if (result.status == "exists") {
						// The user already has an extension, return an ephemeral message saying so
						interaction.editReply({
							content: "You already have an extension!",
							ephemeral: true
						});
					}
				}).catch((error) => {
					// The user doesn't have an extension, create one
					findNextExtension().then((result) => {
						if (result.status == "success") {
							let uid = interaction.user.id;
							let ext = result.result;
							let name = interaction.user.displayName;
							interaction.editReply(`Creating extension ${ext}...`)
							// Create the extension
							createExtension(ext, name, uid).then((result) => {
								if (result.status == "created") {
									interaction.editReply({
										content: "",
										embeds: [{
											"title": "Extension Created!",
											"color": 0x00ff00,
											"description": `The SIP server is \`${config.freepbx.server}\``,
											"fields": [{
												"name": "Extension/Username",
												"value": ext
											},
											{
												"name": "Password",
												"value": `||${result.result.fetchExtension.user.extPassword}||`
											}
											]
										}]
									})
									sendLog(`${colors.cyan("[INFO]")} Created extension ${ext} for user ${uid}`);
									// Add the role to the user on Discord based on the ID in the config file
									let role = interaction.guild.roles.cache.find(role => role.id === config.discord.roleId);
									interaction.member.roles.add(role);
								}
							}).catch((error) => {
								interaction.editReply(`Error creating extension: ${error}`);
							});
						}
					}).catch((error) => {
						interaction.editReply(`Error finding next available extension: ${error}`);
					});
				});
				break;
			case "whoami":
				await interaction.deferReply({
					ephemeral: true
				});
				lookupExtension(interaction.user.id, "uid").then((result) => {
					if (result.status == "exists") {
						// The user already has an extension, return an ephemeral message saying so
						interaction.editReply({
							content: "",
							embeds: [{
								"title": "Extension Info",
								"color": 0x00ff00,
								"description": `The SIP server is \`${config.freepbx.server}\``,
								"fields": [{
									"name": "Extension/Username",
									"value": result.result.fetchExtension.user.extension
								},
								{
									"name": "Password",
									"value": `||${result.result.fetchExtension.user.extPassword}||`
								}
								]
							}],
							ephemeral: true
						})
					}
				}).catch((error) => {
					// The user doesn't have an extension, create one
					sendLog(`${colors.red("[ERROR]")} ${error}`)
					interaction.editReply({
						content: "You don't have an extension!",
						ephemeral: true
					});
				});
				break;

			case "list":
				await interaction.deferReply({
					ephemeral: false
				});
				generateExtensionListEmbed().then((result) => {
					interaction.editReply({
						content: "",
						embeds: result
					});
				}).catch((error) => {
					interaction.editReply(`Error generating extension list: ${error}`);
				});
				break;
			case "delete":
				if (interaction.options.get("confirm").value == false) {
					interaction.reply({
						content: "Please confirm you want to delete your extension by running `/delete confirm:true`",
						ephemeral: true
					})
					break;
				}
				await interaction.deferReply({
					ephemeral: true
				});
				lookupExtension(interaction.user.id, "uid").then((result) => {
					if (result.status == "exists") {
						// The user has an extension, delete it
						deleteExtension(result.result.fetchExtension.user.extension).then((result) => {
							if (result.status == "deleted") {
								interaction.editReply({
									content: "Extension Deleted!",
									ephemeral: true
								});
								sendLog(`${colors.green("[INFO]")} ${interaction.user.displayName} (${interaction.user.id}) deleted extension ${result.result.fetchExtension.user.extension}`)
								// Remove the role from the user on Discord based on the ID in the config file
								let role = interaction.guild.roles.cache.find(role => role.id === config.discord.roleId);
								interaction.member.roles.remove(role);
							}
						}).catch((error) => {
							interaction.reply(`Error deleting extension: ${error}`);
						});
					}
				}).catch((error) => {
					// The user doesn't have an extension, return an ephemeral message saying so
					interaction.editReply({
						content: "You don't have an extension!",
						ephemeral: true
					});
				});
				break;
			case "button":
				interaction.channel.send({
					embeds: embeds.controls,
					components: [{
						type: 1,
						components: [{
							type: 2,
							label: "Get an Extension",
							emoji: {
								name: "✅"
							},
							style: 3,
							custom_id: "new"
						},
						{
							type: 2,
							label: "Get your extension info",
							emoji: {
								name: "ℹ️"
							},
							style: 1,
							custom_id: "whoami"
						},
						{
							type: 2,
							label: "Delete your extension",
							emoji: {
								name: "❌"
							},
							style: 4,
							custom_id: "delete"
						},
						]
					}]
				}).then(() => {
					interaction.reply({
						content: "Button sent!",
						ephemeral: true
					})
				});
				break;
			case "name": // Update the users extension name, name is optional and defaults to the users Discord displayName
				// sanity check the name, remove any quotes, escape any escape characters
				let name;
				if (!interaction.options.get("name")) {
					name = interaction.user.displayName;
				} else {
					name = interaction.options.get("name").value;
				}
				name = name.replace(/"/g, "");
				name = name.replace(/\\/g, "\\\\"); // Fuck you cayden

				await interaction.deferReply({
					ephemeral: true
				});
				lookupExtension(interaction.user.id, "uid").then((result) => {
					if (result.status == "exists") {
						// The user has an extension, update the name
						updateName(result.result.fetchExtension.user.extension, name).then((result2) => {
							if (result2.status == "updated") {
								interaction.editReply({
									content: "Extension Name Updated!",
									ephemeral: true
								});
								sendLog(`${colors.green("[INFO]")} ${interaction.user.displayName} (${interaction.user.id}) updated extension ${result.result.fetchExtension.user.extension} name to ${name}`)
							}
						}).catch((error) => {
							interaction.editReply(`Error updating extension name: ${error}`);
						});
					}
				}).catch((error) => {
					// The user doesn't have an extension, return an ephemeral message saying so
					interaction.editReply({
						content: "You don't have an extension!",
						ephemeral: true
					});
				});
				break;
			case "paging": // Add/Remove yourself from paging groups
				var conn = await pool.getConnection();
				await interaction.deferReply({
					ephemeral: true
				});
				// Get the users extension, if they don't have one, return an ephemeral message saying so
				lookupExtension(interaction.user.id, "uid").then((result) => {
					if (result.status == "exists") {
						// The user has an extension, add/remove them from the paging group
						let ext = result.result.fetchExtension.user.extension;
						let group = interaction.options.get("group").value;
						let method = interaction.options.get("method").value;
						switch (method) {
							case "add":
								// Check the db if they're already in the group
								conn.query(`SELECT * FROM paging_groups WHERE ext = ${ext} AND \`page_number\` = ${group}`).then((result) => {
									if (result.length == 0) {
										// They're not in the group, add them
										conn.query(`INSERT INTO paging_groups (\`ext\`, \`page_number\`) VALUES (${ext}, ${group})`).then((result) => {
											pbxClient.request(funcs.minifyQuery(funcs.generateQuery('reload', {
												id: "UpdatePaging"
											}))).then(() => {
												interaction.editReply({
													content: "Added you to the paging group!",
													ephemeral: true
												});
												sendLog(`${colors.green("[INFO]")} ${interaction.user.displayName} (${interaction.user.id}) added themselves to paging group ${group}`)
											});
										}).catch((error) => {
											interaction.editReply(`Error adding you to the paging group: ${error}`);
											sendLog(`${colors.red("[ERROR]")} ${error}`);
										});
									} else {
										// They're already in the group, return an ephemeral message saying so
										interaction.editReply({
											content: "You're already in that paging group!",
											ephemeral: true
										});
									}
								}).catch((error) => {
									interaction.editReply(`Error adding you to the paging group: ${error}`);
									sendLog(`${colors.red("[ERROR]")} ${error}`);
								});
								break;
							case "remove":
								// Check if they're in the group
								conn.query(`SELECT * FROM paging_groups WHERE ext = ${ext} AND \`page_number\` = ${group}`).then((result) => {
									if (result.length == 0) {
										// They're not in the group, return an ephemeral message saying so
										interaction.editReply({
											content: "You're not in that paging group!",
											ephemeral: true
										});
									} else {
										// They're in the group, remove them
										conn.query(`DELETE FROM paging_groups WHERE ext = ${ext} AND \`page_number\` = ${group}`).then((result) => {
											pbxClient.request(funcs.minifyQuery(funcs.generateQuery('reload', {
												id: "UpdatePaging"
											}))).then(() => {
												interaction.editReply({
													content: "Removed you from the paging group!",
													ephemeral: true
												});
												sendLog(`${colors.green("[INFO]")} ${interaction.user.displayName} (${interaction.user.id}) removed themselves from paging group ${group}`)
											});
										}).catch((error) => {
											interaction.editReply(`Error removing you from the paging group: ${error}`);
											sendLog(`${colors.red("[ERROR]")} ${error}`);
										});
									}
								}).catch((error) => {
									interaction.editReply(`Error removing you from the paging group: ${error}`);
									sendLog(`${colors.red("[ERROR]")} ${error}`);
								});
								break;
						}
					}
				}).catch((error) => {
					// The user doesn't have an extension, return an ephemeral message saying so, and how to get one (/new)
					interaction.editReply({
						content: "You don't have an extension! Run `/new` to get one!",
						ephemeral: true
					});
				})
				conn.end();
				break;
			default:
				break;
		}
	}
	if (interaction.isButton()) {
		switch (interaction.customId) {
			case "new":
				await interaction.deferReply({
					ephemeral: true
				});
				lookupExtension(interaction.user.id, "uid").then((result) => {
					if (result.status == "exists") {
						// The user already has an extension, return an ephemeral message saying so
						interaction.editReply({
							content: "You already have an extension!",
							ephemeral: true
						});
					}
				}).catch((error) => {
					// The user doesn't have an extension, create one
					findNextExtension().then((result) => {
						if (result.status == "success") {
							let uid = interaction.user.id;
							let ext = result.result;
							let name = interaction.user.displayName;
							interaction.editReply(`Creating extension ${ext}...`)
							// Create the extension
							createExtension(ext, name, uid).then((result) => {
								if (result.status == "created") {
									interaction.editReply({
										content: "",
										embeds: [{
											"title": "Extension Created!",
											"color": 0x00ff00,
											"description": `The SIP server is \`${config.freepbx.server}\``,
											"fields": [{
												"name": "Extension/Username",
												"value": ext
											},
											{
												"name": "Password",
												"value": `||${result.result.fetchExtension.user.extPassword}||`
											}
											]
										}]
									})
									sendLog(`${colors.cyan("[INFO]")} Created extension ${ext} for user ${uid}`);
									// Add the role to the user on Discord based on the ID in the config file
									let role = interaction.guild.roles.cache.find(role => role.id === config.discord.roleId);
									interaction.member.roles.add(role);
								}
							}).catch((error) => {
								interaction.editReply(`Error creating extension: ${error}`);
							});
						}
					}).catch((error) => {
						interaction.editReply(`Error finding next available extension: ${error}`);
					});
				});
				break;
			case "delete":
				interaction.reply({
					content: "Are you sure you want to delete your extension?\nThis action is **irreversible**!\nAll voicemails, call history, and other data will be **permanently deleted**!\n\n**Only do this if you're absolutely sure you want to delete your extension!**",
					ephemeral: true,
					components: [{
						type: 1,
						components: [{
							type: 2,
							label: "Yes",
							emoji: {
								name: "✅"
							},
							style: 4,
							custom_id: "delete2"
						}]
					}]
				}).then(() => {
					setTimeout(() => {
						try {
							interaction.deleteReply();
						} catch (error) {
							// ignore
						}
					}, 10000);
				});
				break;
			case "delete2":
				await interaction.deferReply({
					ephemeral: true
				});
				lookupExtension(interaction.user.id, "uid").then((result) => {
					if (result.status == "exists") {
						// The user has an extension, delete it
						deleteExtension(result.result.fetchExtension.user.extension).then((delResult) => {
							if (delResult.status == "deleted") {
								interaction.editReply({
									content: "Extension Deleted!",
									ephemeral: true
								});
								sendLog(`${colors.green("[INFO]")} ${interaction.user.displayName} (${interaction.user.id}) deleted extension ${result.result.fetchExtension.user.extension}`)
								// Remove the role from the user on Discord based on the ID in the config file
								let role = interaction.guild.roles.cache.find(role => role.id === config.discord.roleId);
								interaction.member.roles.remove(role);
							}
						}).catch((error) => {
							// sendLog full error with line number

							interaction.editReply(`Error deleting extension: ${error}`);
						});
					}
				}).catch((error) => {
					// The user doesn't have an extension, return an ephemeral message saying so
					interaction.editReply({
						content: "You don't have an extension!",
						ephemeral: true
					});
				});
				break;
			case "whoami":
				await interaction.deferReply({
					ephemeral: true
				});
				lookupExtension(interaction.user.id, "uid").then((result) => {
					if (result.status == "exists") {
						// The user already has an extension, return an ephemeral message saying so
						interaction.editReply({
							content: "",
							embeds: [{
								"title": "Extension Info",
								"color": 0x00ff00,
								"description": `The SIP server is \`${config.freepbx.server}\``,
								"fields": [{
									"name": "Extension/Username",
									"value": result.result.fetchExtension.user.extension
								},
								{
									"name": "Password",
									"value": `||${result.result.fetchExtension.user.extPassword}||`
								}
								]
							}],
							ephemeral: true
						})
					}
				}).catch((error) => {
					// The user doesn't have an extension, create one
					sendLog(`${colors.red("[ERROR]")} ${error}`)
					interaction.editReply({
						content: "You don't have an extension!",
						ephemeral: true
					});
				});
				break;
		}
	}
	if (interaction.isUserContextMenuCommand()) {
		switch (interaction.commandName) {
			case "Lookup Extension":
				// Get the extension for the user if they have one
				await interaction.deferReply({
					ephemeral: true
				});
				lookupExtension(interaction.targetId, "uid").then((result) => {
					if (result.status == "exists") {
						// The user already has an extension, return an ephemeral message saying so
						interaction.editReply({
							content: `${interaction.targetUser} has extension \`${result.result.fetchExtension.user.extension}\``,
							ephemeral: true
						})
					}
				}).catch((error) => {
					// The user doesn't have an extension, create one
					sendLog(`${colors.red("[ERROR]")} ${error}`)
					interaction.editReply({
						content: "That user doesn't have an extension!",
						ephemeral: true
					});
				});
				break;
			case "Create Extension": // Create an extension for the user, if they have one, return the extension info
				await interaction.deferReply({
					ephemeral: true
				});
				lookupExtension(interaction.targetId, "uid").then((result) => {
					if (result.status == "exists") {
						// The user already has an extension, return an ephemeral message saying so
						interaction.editReply({
							content: "",
							embeds: [{
								"title": "Extension Info",
								"color": 0x00ff00,
								"description": `The SIP server is \`${config.freepbx.server}\``,
								"fields": [{
									"name": "Extension/Username",
									"value": result.result.fetchExtension.user.extension
								},
								{
									"name": "Password",
									"value": `||${result.result.fetchExtension.user.extPassword}||`
								}
								]
							}]
						});
					}
				}).catch((error) => {
					// The user doesn't have an extension, create one
					findNextExtension().then((result) => {
						if (result.status == "success") {
							let uid = interaction.targetId;
							let ext = result.result;
							let name = interaction.targetUser.displayName;
							interaction.editReply(`Creating extension ${ext}...`)
							// Create the extension
							createExtension(ext, name, uid).then((result) => {
								if (result.status == "created") {
									interaction.editReply({
										content: "",
										embeds: [{
											"title": "Extension Created!",
											"color": 0x00ff00,
											"description": `The SIP server is \`${config.freepbx.server}\``,
											"fields": [{
												"name": "Extension/Username",
												"value": ext
											},
											{
												"name": "Password",
												"value": `||${result.result.fetchExtension.user.extPassword}||`
											}
											]
										}]
									})
									sendLog(`${colors.cyan("[INFO]")} Admin ${interaction.user.displayName} Created extension ${ext} for user ${interaction.targetUser.displayName} (${interaction.targetId})`);
									// Add the role to the user on Discord based on the ID in the config file
									let role = interaction.guild.roles.cache.find(role => role.id === config.discord.roleId);
									interaction.targetMember.roles.add(role);
								}
							}).catch((error) => {
								interaction.editReply(`Error creating extension: ${error}`);
							});
						}
					}).catch((error) => {
						interaction.editReply(`Error finding next available extension: ${error}`);
					});
				});
				break;
			case "Delete Extension": // Delete the users extension, if they have one
				await interaction.deferReply({
					ephemeral: true
				});
				lookupExtension(interaction.targetId, "uid").then((result) => {
					if (result.status == "exists") {
						// The user has an extension, delete it
						deleteExtension(result.result.fetchExtension.user.extension).then((delResult) => {
							if (delResult.status == "deleted") {
								interaction.editReply({
									content: "Extension Deleted!",
									ephemeral: true
								});
								sendLog(`${colors.green("[INFO]")} ${interaction.user.displayName} deleted ${interaction.targetUser.username}'s extension ${result.result.fetchExtension.user.extension}`)
								// Remove the role from the user on Discord based on the ID in the config file
								let role = interaction.guild.roles.cache.find(role => role.id === config.discord.roleId);
								interaction.targetMember.roles.remove(role);
							}
						}).catch((error) => {
							// sendLog full error with line number

							interaction.editReply(`Error deleting extension: ${error}`);
						});
					}
				}).catch((error) => {
					// The user doesn't have an extension, return an ephemeral message saying so
					interaction.editReply({
						content: "That user doesn't have an extension!",
						ephemeral: true
					});
				});
				break;
		}
	}
});

// Lets actually handle exceptions now
process.on('unhandledRejection', (error) => {
	// Log a full error with line number
	sendLog(`${colors.red("[ERROR]")} ${error}`);
	// If config.ntfyUrl is set, Send the exception to ntfy
	if (config.ntfyUrl) fetch(config.ntfyUrl, {
		method: 'POST', // PUT works too
		body: error,
		headers: {
			'Title': 'FreePBX Bot Rejection',
			'Priority': 5,
			'Tags': 'warning,phone,FreePBX Manager'
		}
	});
});

process.on('uncaughtException', (error) => {
	// Log a full error with line number
	sendLog(`${colors.red("[ERROR]")} ${error}`);
	// If config.ntfyUrl is set, Send the exception to ntfy
	if (config.ntfyUrl) fetch(config.ntfyUrl, {
		method: 'POST', // PUT works too
		body: error,
		headers: {
			'Title': 'FreePBX Bot Exception',
			'Priority': 5,
			'Tags': 'warning,phone,FreePBX Manager'
		}
	});
});

dcClient.login(config.discord.token);