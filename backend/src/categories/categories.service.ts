import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Category } from './entities/category.entity';

@Injectable()
export class CategoriesService {
  constructor(
    @InjectRepository(Category)
    private readonly categoryRepository: Repository<Category>,
  ) {}

  async findAllCategories() {
    return await this.categoryRepository.find({
      relations: {
        // parent: true,
        children: true,
      },
      order: {
        id: 'DESC',
      },
    });
  }
}
