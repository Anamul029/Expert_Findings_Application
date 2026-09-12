import { Controller, Get } from '@nestjs/common';
import { CategoriesService } from './categories.service';

@Controller({ path: 'categories', version: '1' })
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Get()
  findAll() {
    return this.categoriesService.findAll();
  }
}
