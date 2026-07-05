import { validate } from "./validate";
import { newGame } from "./new-game";
import { listRegistries } from "./list-registries";
import { genMap } from "./gen-map";
import { exportMap } from "./export-map";

const USAGE = `用法: pnpm tools <子命令> [参数]

子命令:
  validate [configPath]            校验 game/ 目录下的所有配置
  new-game [id] [--name <n>] [--out <dir>] [--tick-rate <n>]
                                   生成 game/ + src/ 脚手架
  list-registries                  列出框架已注册的原型/动作/系统/组件/生成器
  gen-map <generatorId> [--seed <n>] [--width <n>] [--height <n>] [--out <dir>]
                                   调用生成器产出地图 JSON + PNG
  export-map <mapId> [--out <dir>] 把 MapRuntime 导出为 JSON + PNG`;

function main(): void {
  const subcommand = process.argv[2];
  const args = process.argv.slice(3);

  switch (subcommand) {
    case "validate":
      validate(args);
      break;
    case "new-game":
      newGame(args);
      break;
    case "list-registries":
      listRegistries();
      break;
    case "gen-map":
      genMap(args);
      break;
    case "export-map":
      exportMap(args);
      break;
    case undefined:
    case "--help":
    case "-h":
      console.log(USAGE);
      break;
    default:
      console.error(`未知子命令: ${subcommand}`);
      console.log(USAGE);
      process.exit(1);
  }
}

main();
