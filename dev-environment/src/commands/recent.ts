import { Command } from 'commander';
import prompts from 'prompts';

const fruits = ['Apple', 'Banana', 'Orange', 'Strawberry', 'Mango'];

export const recentCommand = new Command('recent')
  .description('Select a fruit from the recent list')
  .action(async () => {
    const response = await prompts({
      type: 'select',
      name: 'fruit',
      message: 'Select a fruit',
      choices: [
        { title: 'Do nothing (default)', value: 'nothing' },
        ...fruits.map(fruit => ({ title: fruit, value: fruit }))
      ],
      initial: 0
    });

    if (response.fruit === undefined) {
      console.error('Selection cancelled.');
    } else if (response.fruit === 'nothing') {
      console.log('Nothing selected.');
    } else {
      console.log(response.fruit);
    }
  });