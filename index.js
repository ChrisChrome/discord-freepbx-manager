//Load static files
const config = require("./config.json");
const funcs = require("./funcs.js");
const colors = require("colors");
const embeds = require("./embeds.json")
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

// Some functions for FreePBX


const getExtCount = () => {
	return new Promise((resolve, reject) => {
		pbxClient.request(funcs.generateQuery('list', {})).then((result) => {
			resolve(result.fetchAllExtensions.extension.length);
		}).catch((error) => {
			reject(error);
		});
	});
}


const createExtension = (ext, name, uid) => {
	return new Promise((resolve, reject) => {
		pbxClient.request(funcs.generateQuery('lookup', {
			ext: ext
		})).then((result) => {
			// Extension exists
			res = {
				"status": "exists",
			}
			resolve(res);
		}).catch((error) => {
			// Extension does not exist, create it, reload, look it up, and return the result
			pbxClient.request(funcs.generateQuery('add', {
				ext: ext,
				name: name,
				uid: uid
			})).then((result) => {
				pbxClient.request(funcs.generateQuery('reload', {
					id: "CreateExt"
				})).then((result) => {
					pbxClient.request(funcs.generateQuery('lookup', {
						ext: ext
					})).then((result) => {
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

// deleteExtension, takes an extension number
const deleteExtension = (ext) => {
	return new Promise((resolve, reject) => {
		pbxClient.request(funcs.generateQuery('delete', {
			ext: ext
		})).then((result) => {
			pbxClient.request(funcs.generateQuery('reload', {
				id: "DeleteExt"
			})).then((result) => {
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

const lookupExtension = (ident, type) => { // type is either "ext" or "uid"
	return new Promise((resolve, reject) => {
		switch (type) {
			case "ext":
				pbxClient.request(funcs.generateQuery('lookup', {
					ext: ident
				})).then((result) => {
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
				pbxClient.request(funcs.generateQuery('list', {})).then(async (result) => {
					// loop through all extensions, run a lookup on each one, and return the first one that matches
					var found = false;
					var ext = "";
					var count = 0;
					result.fetchAllExtensions.extension.forEach(async (ext) => {
						pbxClient.request(funcs.generateQuery('lookup', {
							ext: ext.user.extension
						})).then((result) => {
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
		pbxClient.request(funcs.generateQuery('list', {})).then((result) => {
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
			if(curMsg.length + message.length < 2000) {
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

		sendLog(`${colors.cyan("[INFO]")} Logged in as ${dcClient.user.tag}!`);


		// Set up application commands
		const commands = require('./commands.json');

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
		pbxClient.request(funcs.generateQuery("list", {})).then((result) => {
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
					pbxClient.request(funcs.generateQuery("list", {})).then((result) => {
						let extensions = result.fetchAllExtensions.extension;
						// key:value pairs of extension:username
						let extensionList = {};
						extensions.forEach((extension) => {
							extensionList[extension.user.extension] = extension.user.name;
						});
						extensionList1 = "";
						for (let key in extensionList) {
							extensionList1 += `${key}: ${extensionList[key]}\n`;
						}
						extListChannel.send({
							content: "",
							embeds: [{
								"title": "Extension List",
								"color": 0x00ff00,
								"description": `${extensionList1}`
							}]
						});
					})
				} else {
					pbxClient.request(funcs.generateQuery("list", {})).then((result) => {
						let extensions = result.fetchAllExtensions.extension;
						// key:value pairs of extension:username
						let extensionList = {};
						extensions.forEach((extension) => {
							extensionList[extension.user.extension] = extension.user.name;
						});
						extensionList1 = "";
						for (let key in extensionList) {
							extensionList1 += `${key}: ${extensionList[key]}\n`;
						}
						messages.first().edit({
							content: "",
							embeds: [{
								"title": "Extension List",
								"color": 0x00ff00,
								"description": `${extensionList1}`
							}]
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
				pbxClient.request(funcs.generateQuery("list", {})).then((result) => {
					let extensions = result.fetchAllExtensions.extension;
					// key:value pairs of extension:username
					let extensionList = {};
					extensions.forEach((extension) => {
						extensionList[extension.user.extension] = extension.user.name;
					});
					extensionList1 = "";
					for (let key in extensionList) {
						extensionList1 += `${key}: ${extensionList[key]}\n`;
					}
					extListChannel.send({
						content: "",
						embeds: [{
							"title": "Extension List",
							"color": 0x00ff00,
							"description": `${extensionList1}`
						}]
					});
				})
			} else {
				pbxClient.request(funcs.generateQuery("list", {})).then((result) => {
					let extensions = result.fetchAllExtensions.extension;
					// key:value pairs of extension:username
					let extensionList = {};
					extensions.forEach((extension) => {
						extensionList[extension.user.extension] = extension.user.name;
					});
					extensionList1 = "";
					for (let key in extensionList) {
						extensionList1 += `${key}: ${extensionList[key]}\n`;
					}
					messages.first().edit({
						content: "",
						embeds: [{
							"title": "Extension List",
							"color": 0x00ff00,
							"description": `${extensionList1}`
						}]
					});
				})
			}
		})

	});

});

dcClient.on("guildMemberRemove", (member) => {
	// Delete the extension if the user leaves the server
	sendLog(`${colors.cyan("[INFO]")} User ${member.id} left the server`)
	lookupExtension(member.id, "uid").then((result) => {
		if (result.status == "exists") {
			sendLog(`${colors.cyan("[INFO]")} User ${member.id} has extension ${result.result.fetchExtension.user.extension}, deleting it`)
			deleteExtension(result.result.fetchExtension.user.extension).then((result) => {
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
							let name = interaction.user.tag;
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
				pbxClient.request(funcs.generateQuery("list", {})).then((result) => {
					let extensions = result.fetchAllExtensions.extension;
					// key:value pairs of extension:username
					let extensionList = {};
					extensions.forEach((extension) => {
						extensionList[extension.user.extension] = extension.user.name;
					});
					extensionList1 = "";
					for (let key in extensionList) {
						extensionList1 += `${key}: ${extensionList[key]}\n`;
					}
					interaction.editReply({
						content: "",
						embeds: [{
							"title": "Extension List",
							"color": 0x00ff00,
							"description": `${extensionList1}`
						}]
					});
				}).catch((error) => {
					interaction.editReply(`Error listing extensions: ${error}`);
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
								sendLog(`${colors.green("[INFO]")} ${interaction.user.tag} (${interaction.user.id}) deleted extension ${result.result.fetchExtension.user.extension}`)
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
							let name = interaction.user.tag;
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
						deleteExtension(result.result.fetchExtension.user.extension).then((result) => {
							if (result.status == "deleted") {
								interaction.editReply({
									content: "Extension Deleted!",
									ephemeral: true
								});
								sendLog(`${colors.green("[INFO]")} ${interaction.user.tag} (${interaction.user.id}) deleted extension ${result.result.fetchExtension.user.extension}`)
								// Remove the role from the user on Discord based on the ID in the config file
								let role = interaction.guild.roles.cache.find(role => role.id === config.discord.roleId);
								interaction.member.roles.remove(role);
							}
						}).catch((error) => {
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
});


dcClient.login(config.discord.token);